import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { pushPending, getPendingCount } from '../lib/sync';

type SyncContextValue = {
  isOnline: boolean;
  pendingCount: number;
  syncNow: () => Promise<void>;
};

const SyncContext = createContext<SyncContextValue>({
  isOnline: true,
  pendingCount: 0,
  syncNow: async () => {},
});

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline]       = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const syncing      = useRef(false);
  const failCount    = useRef(0);
  const nextRetryAt  = useRef(0);

  const refreshPendingCount = useCallback(async () => {
    try { setPendingCount(await getPendingCount()); } catch {}
  }, []);

  const syncNow = useCallback(async () => {
    if (syncing.current) return;
    if (Date.now() < nextRetryAt.current) return;   // respect backoff window
    syncing.current = true;
    const before = await getPendingCount().catch(() => 0);
    try {
      await pushPending();
    } catch {
      // Network errors are expected; individual record failures are handled inside pushPending
    } finally {
      syncing.current = false;
      const after = await getPendingCount().catch(() => before);
      setPendingCount(after);
      if (after === 0 || after < before) {
        // Progress made — reset backoff
        failCount.current   = 0;
        nextRetryAt.current = 0;
      } else if (before > 0) {
        // No progress despite pending records — back off exponentially (5 s, 10 s, 20 s … 5 min)
        failCount.current  += 1;
        const delay = Math.min(5_000 * 2 ** (failCount.current - 1), 300_000);
        nextRetryAt.current = Date.now() + delay;
      }
    }
  }, []);

  useEffect(() => {
    // Get initial network state
    NetInfo.fetch().then(state => {
      setIsOnline(state.isConnected === true && state.isInternetReachable !== false);
    });

    const unsubscribe = NetInfo.addEventListener(async (state) => {
      const online = state.isConnected === true && state.isInternetReachable !== false;
      setIsOnline(online);
      if (online) await syncNow();
    });

    // Refresh pending count on mount and every 15 seconds
    refreshPendingCount();
    const interval = setInterval(refreshPendingCount, 15_000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [syncNow, refreshPendingCount]);

  return (
    <SyncContext.Provider value={{ isOnline, pendingCount, syncNow }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  return useContext(SyncContext);
}
