import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

type SettingsCtx = {
  CompactMode: boolean;
  toggleCompactMode: () => void;
  SeasonCalendarView: boolean;
  toggleSeasonCalendarView: () => void;
};

const Ctx = createContext<SettingsCtx>({
  CompactMode: false, toggleCompactMode: () => {},
  SeasonCalendarView: false, toggleSeasonCalendarView: () => {},
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [CompactMode, setCompactMode] = useState(false);
  const [SeasonCalendarView, setSeasonCalendarView] = useState(false);

  useEffect(() => {
    AsyncStorage.multiGet(['compact_mode', 'season_calendar_view']).then(([[, cm], [, cv]]) => {
      if (cm === 'true') setCompactMode(true);
      if (cv === 'true') setSeasonCalendarView(true);
    });
  }, []);

  function toggleCompactMode() {
    const Next = !CompactMode;
    setCompactMode(Next);
    AsyncStorage.setItem('compact_mode', String(Next));
  }

  function toggleSeasonCalendarView() {
    const Next = !SeasonCalendarView;
    setSeasonCalendarView(Next);
    AsyncStorage.setItem('season_calendar_view', String(Next));
  }

  return (
    <Ctx.Provider value={{ CompactMode, toggleCompactMode, SeasonCalendarView, toggleSeasonCalendarView }}>
      {children}
    </Ctx.Provider>
  );
}

export const useSettings = () => useContext(Ctx);
