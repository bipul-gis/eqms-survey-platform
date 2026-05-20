import {
  getDocs,
  getDocsFromCache,
  type Query,
  type QuerySnapshot
} from 'firebase/firestore';

type CapacitorNetworkPlugin = {
  getStatus: () => Promise<{ connected: boolean }>;
};

/** True when running inside the Capacitor Android/iOS shell. */
export function isCapacitorNative(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
      ?.isNativePlatform?.() === true
  );
}

function capacitorNetworkPlugin(): CapacitorNetworkPlugin | null {
  if (typeof window === 'undefined') return null;
  const plugins = (window as unknown as { Capacitor?: { Plugins?: { Network?: CapacitorNetworkPlugin } } })
    .Capacitor?.Plugins;
  return plugins?.Network ?? null;
}

export function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Android WebView often reports `navigator.onLine === true` on Wi‑Fi/cell with
 * no actual route to the internet — Firestore then blocks until timeout.
 */
export async function isDeviceOffline(): Promise<boolean> {
  if (isBrowserOffline()) return true;
  const network = capacitorNetworkPlugin();
  if (!network) return false;
  try {
    const status = await network.getStatus();
    return !status.connected;
  } catch {
    return false;
  }
}

/** How long we wait for a local-cache write before treating it as queued. */
const LOCAL_WRITE_WAIT_MS = 4000;

/**
 * Commit a Firestore write without blocking enumerators on slow/dead networks.
 * Resolves once the write hits the local persistence layer, or immediately when
 * offline (write continues in the background).
 */
export async function commitFirestoreWrite(write: () => Promise<void>): Promise<void> {
  const offline = await isDeviceOffline();
  if (offline) {
    void write().catch((err) => console.error('Queued offline Firestore write failed', err));
    return;
  }

  let settled = false;
  const done = write().then(
    () => {
      settled = true;
    },
    (err) => {
      settled = true;
      throw err;
    }
  );

  const timer = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), LOCAL_WRITE_WAIT_MS)
  );

  const raced = await Promise.race([done.then(() => 'ok' as const), timer]);
  if (raced === 'timeout' && !settled) {
    void write().catch((err) => console.error('Background Firestore write failed', err));
  }
}

/**
 * Prefer the local cache when offline so enumerators still see drafts they
 * just saved. When online, use the default server-then-cache behaviour.
 */
export async function getDocsOfflineFriendly(q: Query): Promise<QuerySnapshot> {
  if (isBrowserOffline()) {
    try {
      return await getDocsFromCache(q);
    } catch {
      return getDocs(q);
    }
  }
  return getDocs(q);
}
