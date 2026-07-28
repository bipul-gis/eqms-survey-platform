import { useEffect, useState } from 'react';
import {
  countPendingResponses,
  flushOfflineResponseQueue
} from '../lib/offlineResponses';

export interface NetworkState {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
}

/** Online status + offline queue flush on reconnect. */
export function useOnlineStatus(): NetworkState {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  const [syncing, setSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(() =>
    typeof window === 'undefined' ? 0 : countPendingResponses()
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const refreshPending = () => setPendingCount(countPendingResponses());

    const goOnline = () => {
      setOnline(true);
      setSyncing(true);
      void flushOfflineResponseQueue()
        .catch(() => undefined)
        .finally(() => {
          refreshPending();
          setSyncing(false);
        });
    };
    const goOffline = () => {
      setOnline(false);
      setSyncing(false);
      refreshPending();
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    const interval = window.setInterval(refreshPending, 4000);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.clearInterval(interval);
    };
  }, []);

  return { online, syncing, pendingCount };
}
