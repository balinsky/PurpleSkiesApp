import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

type SettingsCtx = {
  CompactMode: boolean;
  toggleCompactMode: () => void;
  SeasonCalendarView: boolean;
  toggleSeasonCalendarView: () => void;
  BandingEnabled: boolean;
  toggleBandingEnabled: () => void;
};

const Ctx = createContext<SettingsCtx>({
  CompactMode: false, toggleCompactMode: () => {},
  SeasonCalendarView: false, toggleSeasonCalendarView: () => {},
  BandingEnabled: false, toggleBandingEnabled: () => {},
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [CompactMode, setCompactMode] = useState(false);
  const [SeasonCalendarView, setSeasonCalendarView] = useState(false);
  const [BandingEnabled, setBandingEnabled] = useState(false);

  useEffect(() => {
    AsyncStorage.multiGet(['compact_mode', 'season_calendar_view', 'banding_enabled']).then(([[, cm], [, cv], [, be]]) => {
      if (cm === 'true') setCompactMode(true);
      if (cv === 'true') setSeasonCalendarView(true);
      if (be === 'true') setBandingEnabled(true);
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

  function toggleBandingEnabled() {
    const Next = !BandingEnabled;
    setBandingEnabled(Next);
    AsyncStorage.setItem('banding_enabled', String(Next));
  }

  return (
    <Ctx.Provider value={{ CompactMode, toggleCompactMode, SeasonCalendarView, toggleSeasonCalendarView, BandingEnabled, toggleBandingEnabled }}>
      {children}
    </Ctx.Provider>
  );
}

export const useSettings = () => useContext(Ctx);
