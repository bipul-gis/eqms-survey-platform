import { useEffect, useState } from 'react';

export interface NetworkState {
  online: boolean;
  syncing: boolean;
}

/** Online status from browser events (online-first API mode). */
export function useOnlineStatus(): NetworkState {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const goOnline = () => {
      setOnline(true);
      setSyncing(true);
      window.setTimeout(() => setSyncing(false), 1500);
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

  return { online, syncing };
}
