import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

type SettingsCtx = {
  CompactMode: boolean;
  toggleCompactMode: () => void;
  SeasonCalendarView: boolean;
  toggleSeasonCalendarView: () => void;
  BandingEnabled: boolean;
  toggleBandingEnabled: () => void;
  FledgingWarnDays: number;
  setFledgingWarnDays: (days: number) => void;
};

const Ctx = createContext<SettingsCtx>({
  CompactMode: false, toggleCompactMode: () => {},
  SeasonCalendarView: false, toggleSeasonCalendarView: () => {},
  BandingEnabled: false, toggleBandingEnabled: () => {},
  FledgingWarnDays: 4, setFledgingWarnDays: () => {},
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [CompactMode, setCompactMode] = useState(false);
  const [SeasonCalendarView, setSeasonCalendarView] = useState(false);
  const [BandingEnabled, setBandingEnabled] = useState(false);
  const [FledgingWarnDays, setFledgingWarnDaysState] = useState(4);

  useEffect(() => {
    AsyncStorage.multiGet(['compact_mode', 'season_calendar_view', 'banding_enabled', 'fledging_warn_days']).then(([[, cm], [, cv], [, be], [, fd]]) => {
      if (cm === 'true') setCompactMode(true);
      if (cv === 'true') setSeasonCalendarView(true);
      if (be === 'true') setBandingEnabled(true);
      if (fd !== null) setFledgingWarnDaysState(parseInt(fd, 10));
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

  function setFledgingWarnDays(days: number) {
    setFledgingWarnDaysState(days);
    AsyncStorage.setItem('fledging_warn_days', String(days));
  }

  return (
    <Ctx.Provider value={{ CompactMode, toggleCompactMode, SeasonCalendarView, toggleSeasonCalendarView, BandingEnabled, toggleBandingEnabled, FledgingWarnDays, setFledgingWarnDays }}>
      {children}
    </Ctx.Provider>
  );
}

export const useSettings = () => useContext(Ctx);
