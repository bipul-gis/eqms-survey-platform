import { useCallback, useEffect, useState } from 'react';
import {
  countPendingResponses,
  flushOfflineResponseQueue
} from '../lib/offlineResponses';

export interface NetworkState {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  retryPendingUploads: () => Promise<void>;
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

  const refreshPending = useCallback(() => setPendingCount(countPendingResponses()), []);

  const retryPendingUploads = useCallback(async () => {
    if (typeof window === 'undefined' || syncing) return;
    setSyncing(true);
    try {
      await flushOfflineResponseQueue();
    } finally {
      refreshPending();
      setSyncing(false);
    }
  }, [refreshPending, syncing]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const goOnline = () => {
      setOnline(true);
      void retryPendingUploads();
    };
    const goOffline = () => {
      setOnline(false);
      setSyncing(false);
      refreshPending();
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    const interval = window.setInterval(refreshPending, 4000);
    refreshPending();
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.clearInterval(interval);
    };
  }, [refreshPending, retryPendingUploads]);

  return { online, syncing, pendingCount, retryPendingUploads };
}
