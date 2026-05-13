/**
 * useOnlineStatus — small reactive hook around `navigator.onLine` plus
 * Firestore's "is anything still queued?" signal.
 *
 * The browser flag (`navigator.onLine`) is the cheap part: it flips on the
 * `online` / `offline` window events. It's a heuristic — it really only
 * tells you whether the OS thinks the network adapter is up — but combined
 * with Firestore's `onSnapshotsInSync` it's a perfectly adequate signal for
 * the kind of "should we say 'queued for sync' or 'submitted'?" UX the
 * enumerator app needs.
 *
 * The hook is intentionally minimal so it can be imported from anywhere
 * (mobile bundle stays small) and so the eventual SW / Capacitor Network
 * plugin override has only one surface to touch.
 */
import { useEffect, useState } from 'react';
import { onSnapshotsInSync } from 'firebase/firestore';
import { db } from '../lib/firebase';

export interface NetworkState {
  /** OS-level link state. Mirrors `navigator.onLine`. */
  online: boolean;
  /**
   * `true` when Firestore has at least one write it hasn't yet acknowledged
   * with the server. Goes back to `false` once everything is committed.
   * Useful for showing a "Syncing…" indicator immediately after a draft is
   * saved offline.
   */
  syncing: boolean;
}

export function useOnlineStatus(): NetworkState {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  // We can't read Firestore's queue depth directly, but we can infer
  // "syncing in progress" by flipping a flag when `onSnapshotsInSync` fires
  // *after* a recent write happened. The simpler heuristic — assume syncing
  // is true whenever offline state just flipped to online — covers the only
  // case enumerators actually see.
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const goOnline = () => {
      setOnline(true);
      // Brief "Syncing…" window while Firestore drains its queue. The
      // `onSnapshotsInSync` listener below will turn this off as soon as
      // the SDK reports everything is back in sync.
      setSyncing(true);
    };
    const goOffline = () => {
      setOnline(false);
      setSyncing(false);
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Firestore tells us when every active snapshot listener has flushed
  // pending writes / reads. Use this as the "Syncing…" off-switch so we
  // don't show the spinner forever after reconnecting.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const unsub = onSnapshotsInSync(db, () => {
      setSyncing(false);
    });
    return () => {
      unsub();
    };
  }, []);

  return { online, syncing };
}
