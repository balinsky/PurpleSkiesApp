import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

type SettingsCtx = {
  CompactMode: boolean;
  toggleCompactMode: () => void;
};

const Ctx = createContext<SettingsCtx>({ CompactMode: false, toggleCompactMode: () => {} });

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [CompactMode, setCompactMode] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('compact_mode').then((V) => {
      if (V === 'true') setCompactMode(true);
    });
  }, []);

  function toggleCompactMode() {
    const Next = !CompactMode;
    setCompactMode(Next);
    AsyncStorage.setItem('compact_mode', String(Next));
  }

  return <Ctx.Provider value={{ CompactMode, toggleCompactMode }}>{children}</Ctx.Provider>;
}

export const useSettings = () => useContext(Ctx);
