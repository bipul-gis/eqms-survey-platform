/** Online-first stubs — offline queue deferred to mobile app phase. */

export function isCapacitorNative(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
      ?.isNativePlatform?.() === true
  );
}

export function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export async function isDeviceOffline(): Promise<boolean> {
  return isBrowserOffline();
}

export async function writeWithOfflineFallback<T>(
  writeFn: () => Promise<T>,
  _label: string
): Promise<T> {
  return writeFn();
}

export async function readQueryPreferCache<T>(readFn: () => Promise<T>): Promise<T> {
  return readFn();
}
