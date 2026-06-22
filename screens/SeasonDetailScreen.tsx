import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, Dialog, FAB, HelperText, Icon, IconButton, List, Portal, Text, TextInput, TouchableRipple } from 'react-native-paper';
import { exportSeasonXls } from '../lib/exportXls';
import { Calendar } from 'react-native-calendars';
import DateInput from '../components/DateInput';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { friendlyError } from '../lib/errorUtils';
import { AppStackParamList } from '../App';
import { useSettings } from '../contexts/SettingsContext';
import { useSync } from '../contexts/SyncContext';
import {
  cacheNestChecks, getLocalNestChecks,
  insertLocalNestCheck, makeId,
} from '../lib/localDb';

type NestCheck = {
  id: string;
  check_date: string;
};

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'SeasonDetail'>;
  route: RouteProp<AppStackParamList, 'SeasonDetail'>;
};

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function shortDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((new Date(ty, tm - 1, td).getTime() - new Date(fy, fm - 1, fd).getTime()) / 86400000);
}

function labelCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

const UnitTypeLabel: Record<string, string> = {
  metal_house:   'Metal House',
  plastic_house: 'Plastic House',
  wooden_house:  'Wooden House',
  gourd_rack:    'Gourd Rack',
};

type BandRow = {
  year: number;
  compartment_label: string;
  unit_name: string;
  check_date: string;
  band_type: string;
  band_color: string | null;
  band_code: string;
  bird_type: string;       // 'nestling' | 'adult_male' | 'adult_female'
  is_new_banding: boolean;
  nestling_id: string | null;
  nest_check_entry_id: string;
};

type CompartmentProgress = {
  compartment_id: string;
  nesting_attempt: number;
  label: string;
  unit_name: string;
  first_egg_min: string | null;
  first_egg_max: string | null;
  proj_hatch_min: string | null;
  proj_hatch_max: string | null;
  actual_hatch: string | null;
  proj_fledge: string | null;
  fledge_dates: string[];
  male_age: string | null;
  female_age: string | null;
  young_count: number;
  banded_count: number;
  superseded: boolean;
};

type HistoryEntry = {
  check_date: string;
  species: string | null;
  egg_count: number;
  discarded_eggs: number;
  young_count: number;
  nestling_age_days: number | null;
  fledged_count: number;
  dead_young_count: number;
  dead_adult_male: boolean;
  dead_adult_female: boolean;
  has_nest: boolean;
  nest_replaced: boolean;
  is_empty_cavity: boolean;
  adult_present: boolean;
  nest_discarded: boolean;
  nesting_attempt: number;
};

function historyCode(E: HistoryEntry, isNewAttempt: boolean): string {
  if (E.is_empty_cavity) return 'empty';
  const sp = E.species;
  if (!sp || E.adult_present) return '—';
  const isPM = sp === 'PM';
  const ra = (isNewAttempt && E.nesting_attempt > 1)
    ? (E.nesting_attempt === 2 ? ' RA' : ` RA${E.nesting_attempt}`)
    : '';

  if (E.nest_discarded) return (isPM ? 'D' : `${sp}ND`) + ra;

  if (!isPM) {
    const parts = [
      E.egg_count > 0 ? `${E.egg_count}E` : '',
      E.young_count > 0 ? `${E.young_count}Y` : '',
    ].filter(Boolean).join(' ');
    return parts ? `${sp} ${parts}` : `${sp}N`;
  }

  // PM
  const parts: string[] = [];
  if (E.young_count > 0) {
    const age = E.nestling_age_days != null
      ? `${E.nestling_age_days === 0 ? 'HD' : `${E.nestling_age_days}do`}`
      : '';
    parts.push(`${E.young_count}Y${age ? ' ' + age : ''}`);
  }
  if (E.fledged_count > 0)                       parts.push(`${E.fledged_count}F`);
  if (E.dead_young_count > 0)                     parts.push(`${E.dead_young_count}DYD`);
  if (E.dead_adult_male || E.dead_adult_female)   parts.push('DYA');
  if (E.discarded_eggs > 0)                       parts.push(`${E.discarded_eggs}ED`);
  if (E.nest_replaced)                            parts.push('NR');

  if (parts.length > 0) return parts.join(' ') + ra;
  if (E.egg_count > 0) {
    const eParts = [`${E.egg_count}E`];
    if (E.discarded_eggs > 0) eParts.push(`${E.discarded_eggs}ED`);
    if (E.dead_adult_male || E.dead_adult_female) eParts.push('DYA');
    return eParts.join(' ') + ra;
  }
  if (E.has_nest) {
    const nParts = ['PMN'];
    if (E.dead_adult_male || E.dead_adult_female) nParts.push('DYA');
    if (E.nest_replaced) nParts.push('NR');
    return nParts.join(' ') + ra;
  }
  return ra ? ra.trim() : '—';
}

function progressLine(P: CompartmentProgress): string {
  const AgeParts = [P.male_age && `♂ ${P.male_age}`, P.female_age && `♀ ${P.female_age}`].filter(Boolean).join('  ');
  const Age = AgeParts ? `  ·  ${AgeParts}` : '';
  if (P.actual_hatch) {
    let fledge: string;
    if (P.fledge_dates.length > 0) {
      fledge = `  ·  Fledged ${P.fledge_dates.map(shortDate).join(', ')}`;
    } else if (!P.superseded && P.proj_fledge) {
      fledge = `  ·  Earliest Fledge ${shortDate(P.proj_fledge)}`;
    } else {
      fledge = '';
    }
    return `Hatched ${shortDate(P.actual_hatch)}${fledge}${Age}`;
  }
  if (!P.first_egg_min) return AgeParts;
  const eggStr = P.first_egg_min === P.first_egg_max
    ? shortDate(P.first_egg_min)
    : `${shortDate(P.first_egg_min)}–${shortDate(P.first_egg_max!)}`;
  if (!P.proj_hatch_min || P.superseded) return `1st egg: ${eggStr}${Age}`;
  const hatchStr = P.proj_hatch_min === P.proj_hatch_max
    ? shortDate(P.proj_hatch_min)
    : `${shortDate(P.proj_hatch_min)}–${shortDate(P.proj_hatch_max!)}`;
  return `1st egg: ${eggStr}  ·  Hatch: ~${hatchStr}${Age}`;
}

function todayString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function BandingHistogram({ bars, today, selectedDate, onBarPress }: {
  bars: { date: string; count: number }[];
  today: string;
  selectedDate: string | null;
  onBarPress: (date: string) => void;
}) {
  const ScrollRef = useRef<ScrollView>(null);
  const BAR_W    = 44;
  const BAR_SLOT = BAR_W + 4; // BAR_W + marginHorizontal * 2

  useEffect(() => {
    if (bars.length === 0) return;
    const idx = bars.findIndex(b => b.date >= today);
    if (idx > 0) {
      setTimeout(() => ScrollRef.current?.scrollTo({ x: idx * BAR_SLOT, animated: false }), 50);
    }
  }, [bars, today]);

  if (bars.length === 0) {
    return (
      <Text style={{ color: '#888', fontSize: 12, marginBottom: 4, fontStyle: 'italic' }}>
        No banding window available.
      </Text>
    );
  }
  const MaxCount = Math.max(...bars.map(b => b.count), 1);
  const BAR_MAX  = 100;
  const activeDate = selectedDate ?? today;
  return (
    <ScrollView ref={ScrollRef} horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
      <View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: BAR_MAX + 28 }}>
          {bars.map(({ date, count }) => {
            const h        = Math.max(4, Math.round((count / MaxCount) * BAR_MAX));
            const isToday  = date === today;
            const isActive = date === activeDate;
            const barColor = isToday ? '#e65100' : isActive ? '#4a148c' : '#7b1fa2';
            return (
              <Pressable key={date} onPress={() => onBarPress(date)}
                style={{ width: BAR_W, alignItems: 'center', marginHorizontal: 2 }}>
                <Text style={{ fontSize: 10, color: isActive ? '#000' : '#333', fontWeight: isActive ? '700' : '400', marginBottom: 2 }}>{count}</Text>
                <View style={{ width: BAR_W - 10, height: h, backgroundColor: barColor, borderRadius: 3 }} />
              </Pressable>
            );
          })}
        </View>
        <View style={{ flexDirection: 'row' }}>
          {bars.map(({ date }) => {
            const isActive = date === activeDate;
            return (
              <Text key={date} style={{ width: BAR_W, textAlign: 'center', fontSize: 9, color: isActive ? '#000' : '#666', fontWeight: isActive ? '700' : '400', marginHorizontal: 2 }}>
                {shortDate(date)}
              </Text>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}

function BandingCompartmentList({ progress, date, today, min, max }: {
  progress: CompartmentProgress[];
  date: string;
  today: string;
  min: number;
  max: number;
}) {
  const isToday = date === today;
  const items: { label: string; unit_name: string; age: number; unbanded: number }[] = [];
  for (const P of progress) {
    const hatch = P.actual_hatch ?? P.proj_hatch_min;
    if (!hatch) continue;
    const unbanded = Math.max(0, P.young_count - P.banded_count);
    if (unbanded <= 0) continue;
    const age = daysBetween(hatch, date);
    if (age >= min && age <= max) items.push({ label: P.label, unit_name: P.unit_name, age, unbanded });
  }
  items.sort((a, b) => a.unit_name.localeCompare(b.unit_name) || labelCompare(a.label, b.label));
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ fontSize: 12, color: '#555', fontWeight: '600', marginBottom: 4 }}>
        {shortDate(date)}{isToday ? '  (today)' : ''}
      </Text>
      {items.length === 0
        ? <Text style={{ fontSize: 12, color: '#888', fontStyle: 'italic' }}>No unbanded nestlings in window{isToday ? ' today' : ''}.</Text>
        : items.map((item, i) => (
            <Text key={i} style={{ fontSize: 12, color: '#444' }}>
              {item.label}: {item.age} day{item.age !== 1 ? 's' : ''}
              {item.unbanded > 1 ? `  ·  ${item.unbanded} unbanded` : ''}
            </Text>
          ))
      }
    </View>
  );
}

function AgeGenderDisplay({ symbol, confirmed, observations, onIconPress }: {
  symbol: string;
  confirmed: string | null;
  observations: string[];
  onIconPress: () => void;
}) {
  if (observations.length === 0 && !confirmed) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginRight: 10 }}>
      <Text style={{ fontSize: 12, color: '#555' }}>{symbol}</Text>
      <TouchableRipple onPress={onIconPress} borderless style={{ padding: 2 }}>
        <Icon
          source={confirmed ? 'check-circle' : 'help-circle-outline'}
          color={confirmed ? '#22c55e' : '#f59e0b'}
          size={15}
        />
      </TouchableRipple>
      <Text style={{ fontSize: 12, color: '#555' }}>
        {observations.length > 0 ? observations.join(', ') : confirmed}
      </Text>
    </View>
  );
}

function BandsList({ rows }: { rows: BandRow[] }) {
  if (rows.length === 0) {
    return (
      <Text style={{ color: '#888', fontSize: 12, marginBottom: 12, fontStyle: 'italic' }}>
        No bands recorded.
      </Text>
    );
  }

  // Group rows into per-bird boxes. Nestlings share nestling_id across checks;
  // adults use entry+bird_type (group_id isn't persisted to DB).
  type BirdGroup = { key: string; year: number; unit_name: string; compartment_label: string; bird_type: string; check_date: string; bands: BandRow[] };
  const groups: BirdGroup[] = [];
  const seen = new Map<string, BirdGroup>();
  for (const row of rows) {
    const key = row.nestling_id
      ? `n:${row.nestling_id}`
      : `a:${row.nest_check_entry_id}:${row.bird_type}`;
    if (!seen.has(key)) {
      const g: BirdGroup = { key, year: row.year, unit_name: row.unit_name, compartment_label: row.compartment_label, bird_type: row.bird_type, check_date: row.check_date, bands: [] };
      seen.set(key, g);
      groups.push(g);
    }
    seen.get(key)!.bands.push(row);
  }

  const byYear = new Map<number, BirdGroup[]>();
  for (const g of groups) {
    if (!byYear.has(g.year)) byYear.set(g.year, []);
    byYear.get(g.year)!.push(g);
  }

  return (
    <View style={{ marginBottom: 8 }}>
      {[...byYear.entries()].map(([year, yearGroups]) => (
        <View key={year} style={{ marginBottom: 8 }}>
          <Text style={{ fontWeight: '700', fontSize: 13, color: '#444', marginTop: 4, marginBottom: 6 }}>{year}</Text>
          {yearGroups.map((g) => {
            const genderSymbol = g.bird_type === 'adult_male' ? '♂' : g.bird_type === 'adult_female' ? '♀' : null;
            const isReSight = g.bands.every(b => !b.is_new_banding);
            const typeLabel = genderSymbol
              ? `${genderSymbol}${isReSight ? '  re-sight' : ''}`
              : 'Nestling';
            return (
              <View key={g.key} style={{ borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8, marginBottom: 6 }}>
                <View style={{ flexDirection: 'row', marginBottom: g.bands.length > 0 ? 4 : 0 }}>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: '#333', width: 48 }}>{g.compartment_label}</Text>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: '#333', flex: 1 }}>
                    {typeLabel}{'  '}{shortDate(g.check_date)}
                  </Text>
                </View>
                {[...g.bands].sort((a, b) => a.band_type === 'federal' ? -1 : b.band_type === 'federal' ? 1 : 0).map((b, i) => {
                  const parts = [b.band_type, b.band_color, b.band_code].filter(Boolean).join('  ');
                  const reSightSuffix = !b.is_new_banding && !isReSight ? '  (re-sight)' : '';
                  return (
                    <View key={i} style={{ flexDirection: 'row', paddingLeft: 48, paddingVertical: 1 }}>
                      <Text style={{ fontSize: 12, color: '#555' }}>{parts}{reSightSuffix}</Text>
                    </View>
                  );
                })}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export default function SeasonDetailScreen({ navigation, route }: Props) {
  const { SeasonId, SiteId, Year } = route.params;
  const { SeasonCalendarView, toggleSeasonCalendarView, BandingEnabled } = useSettings();
  const { isOnline, syncNow } = useSync();

  const [FirstAsySeen, setFirstAsySeen]           = useState('');
  const [FirstSyMaleSeen, setFirstSyMaleSeen]     = useState('');
  const [DatesLoading, setDatesLoading]           = useState(false);
  const [DatesError, setDatesError]               = useState('');
  const [ArrivalDatesExpanded, setArrivalDatesExpanded] = useState(false);


  const [Exporting, setExporting]         = useState(false);

  const [NestChecks, setNestChecks]       = useState<NestCheck[]>([]);
  const [ChecksLoading, setChecksLoading] = useState(true);
  const [NestProgress, setNestProgress]         = useState<CompartmentProgress[]>([]);
  const [NestProgressExpanded, setNestProgressExpanded] = useState(false);
  const [ColonyStats, setColonyStats]           = useState<{ eggs: number; hatched: number; fledged: number } | null>(null);
  const [CompartmentHistoryId, setCompartmentHistoryId]       = useState<string | null>(null);
  const [CompartmentHistoryLabel, setCompartmentHistoryLabel] = useState('');
  const [CompartmentHistoryEntries, setCompartmentHistoryEntries] = useState<HistoryEntry[]>([]);
  const [CompartmentHistoryLoading, setCompartmentHistoryLoading] = useState(false);

  type AdultAge = {
    compartment_id: string;
    label: string;
    unit_name: string;
    confirmed_male: string | null;
    confirmed_female: string | null;
    male_observations: string[];
    female_observations: string[];
  };
  const [AdultAges, setAdultAges]               = useState<AdultAge[]>([]);
  const [AdultAgesExpanded, setAdultAgesExpanded] = useState(false);
  const [AgeConfirmInfoVisible, setAgeConfirmInfoVisible] = useState(false);

  const [BandingExpanded, setBandingExpanded]         = useState(false);
  const [BandingMin, setBandingMin]                   = useState(14);
  const [BandingMax, setBandingMax]                   = useState(19);
  const [BandingMinText, setBandingMinText]           = useState('14');
  const [BandingMaxText, setBandingMaxText]           = useState('19');
  const [SelectedBandingDate, setSelectedBandingDate] = useState<string | null>(null);

  const [AllBandsData, setAllBandsData]         = useState<BandRow[]>([]);
  const [BandsExpanded, setBandsExpanded]       = useState(false);

  // ── Housing ────────────────────────────────────────────────────────
  type HousingUnit = { id: string; name: string; unit_type: string; default_hole_type: string | null };
  const [SeasonHousingUnits, setSeasonHousingUnits] = useState<HousingUnit[]>([]);
  const [HousingIsLegacy, setHousingIsLegacy]       = useState(false);
  const [HousingExpanded, setHousingExpanded]       = useState(false);
  const [CopyHousingSourceId, setCopyHousingSourceId] = useState<string | null>(null);
  const [CopyHousingSourceYear, setCopyHousingSourceYear] = useState<number | null>(null);
  const [CopyHousingIsLegacy, setCopyHousingIsLegacy] = useState(false);
  const [CopyingHousing, setCopyingHousing]           = useState(false);

  // ── Add check dialog ───────────────────────────────────────────────
  const [AddCheckVisible, setAddCheckVisible]   = useState(false);
  const [NewCheckDate, setNewCheckDate]         = useState('');
  const [AddCheckLoading, setAddCheckLoading]   = useState(false);
  const [AddCheckError, setAddCheckError]       = useState('');

  // ── Delete season ──────────────────────────────────────────────────
  const [DeleteSeasonVisible, setDeleteSeasonVisible] = useState(false);
  const [DeletingSeason, setDeletingSeason]           = useState(false);
  const [DeleteSeasonError, setDeleteSeasonError]     = useState('');

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row' }}>
          <IconButton
            icon="share-variant"
            size={22}
            disabled={Exporting}
            onPress={async () => {
              setExporting(true);
              const Err = await exportSeasonXls(SeasonId, SiteId, Year);
              setExporting(false);
              if (Err) Alert.alert('Export failed', Err);
            }}
          />
          <IconButton
            icon={SeasonCalendarView ? 'format-list-bulleted' : 'calendar-month'}
            size={22}
            onPress={toggleSeasonCalendarView}
          />
          <IconButton
            icon="trash-can-outline"
            size={22}
            iconColor="red"
            disabled={DeletingSeason}
            style={{ marginRight: 4 }}
            onPress={handleDeleteSeasonPress}
          />
        </View>
      ),
    });
  }, [SeasonCalendarView, Exporting, DeletingSeason, NestChecks.length]);

  useEffect(() => {
    AsyncStorage.multiGet([`banding_min_${SiteId}`, `banding_max_${SiteId}`])
      .then(([[, mn], [, mx]]) => {
        const minVal = mn ? parseInt(mn, 10) : 14;
        const maxVal = mx ? parseInt(mx, 10) : 19;
        setBandingMin(minVal);
        setBandingMax(maxVal);
        setBandingMinText(String(minVal));
        setBandingMaxText(String(maxVal));
      });
  }, [SiteId]);

  useFocusEffect(
    useCallback(() => {
      async function loadAll() {
        // Arrival dates
        const { data: SeasonData } = await supabase
          .from('site_seasons')
          .select('date_first_asy_seen, date_first_sy_male_seen')
          .eq('id', SeasonId)
          .single();
        if (SeasonData) {
          setFirstAsySeen(SeasonData.date_first_asy_seen ?? '');
          setFirstSyMaleSeen(SeasonData.date_first_sy_male_seen ?? '');
        }

        // Nest check list — try Supabase, fall back to local cache
        let Checks: { id: string; check_date: string }[] | null = null;
        try {
          const { data } = await supabase
            .from('nest_checks')
            .select('id, check_date')
            .eq('site_id', SiteId)
            .gte('check_date', `${Year}-01-01`)
            .lte('check_date', `${Year}-12-31`)
            .order('check_date', { ascending: true });
          if (data) {
            Checks = data;
            // Fire-and-forget: don't block UI on SQLite availability
            cacheNestChecks(data.map(c => ({ ...c, site_id: SiteId }))).catch(() => {});
          }
        } catch {}
        if (!Checks) {
          try { Checks = await getLocalNestChecks(SiteId, Year); } catch {}
        }
        setNestChecks(Checks ?? []);
        setChecksLoading(false);

        if (!Checks || Checks.length === 0) { setNestProgress([]); return; }

        // Fetch PM entries (nest progress), nest seasons (adult ages), and non-PM entries in parallel
        const [EntriesResult, NestSeasonsResult, NonPMResult] = await Promise.all([
          supabase
            .from('nest_check_entries')
            .select('id, nest_check_id, compartment_id, adult_present, is_empty_cavity, has_nest, egg_count, discarded_eggs, young_count, nestling_age_days, fledged_count, dead_young_count, nesting_attempt, observed_male_age, observed_female_age, compartments(cavity_label, housing_units(name))')
            .in('nest_check_id', Checks.map(c => c.id))
            .eq('species', 'PM'),
          supabase
            .from('nest_seasons')
            .select('compartment_id, male_age, female_age, compartments(cavity_label, housing_units(name))')
            .eq('site_season_id', SeasonId),
          supabase
            .from('nest_check_entries')
            .select('compartment_id, has_nest, egg_count, young_count, is_empty_cavity, adult_present, compartments(cavity_label, housing_units(name))')
            .in('nest_check_id', Checks.map(c => c.id))
            .neq('species', 'PM')
            .not('species', 'is', null),
        ]);
        const Entries        = EntriesResult.data;
        const NestSeasonRows = NestSeasonsResult.data;

        // Build confirmed-age map from nest_seasons
        const AgeMap = new Map<string, { male_age: string | null; female_age: string | null }>();
        if (NestSeasonRows) {
          for (const NS of NestSeasonRows) AgeMap.set(NS.compartment_id, NS);
        }

        // Build per-compartment observation lists from entries
        type ObsData = { male: string[]; female: string[]; label: string; unit_name: string };
        const ObsMap = new Map<string, ObsData>();
        if (Entries) {
          for (const E of Entries as any[]) {
            if (!E.observed_male_age && !E.observed_female_age) continue;
            if (!ObsMap.has(E.compartment_id)) {
              const comp = E.compartments;
              ObsMap.set(E.compartment_id, {
                male: [], female: [],
                label:     comp?.cavity_label ?? '?',
                unit_name: comp?.housing_units?.name ?? '',
              });
            }
            const obs = ObsMap.get(E.compartment_id)!;
            if (E.observed_male_age)   obs.male.push(E.observed_male_age);
            if (E.observed_female_age) obs.female.push(E.observed_female_age);
          }
        }

        // Merge: show all compartments with confirmed ages OR any observation
        const AllCompIds = new Set<string>([
          ...(NestSeasonRows ?? []).map(NS => NS.compartment_id),
          ...ObsMap.keys(),
        ]);
        const Ages: AdultAge[] = [];
        for (const cid of AllCompIds) {
          const obsData = ObsMap.get(cid);
          const ageData = AgeMap.get(cid);
          const hasObs = obsData && (obsData.male.length > 0 || obsData.female.length > 0);
          const hasConfirmed = ageData && (ageData.male_age || ageData.female_age);
          if (!hasObs && !hasConfirmed) continue;
          let label: string;
          let unit_name: string;
          if (obsData) {
            label = obsData.label; unit_name = obsData.unit_name;
          } else {
            const NS = (NestSeasonRows ?? []).find(ns => ns.compartment_id === cid);
            const comp = NS ? (NS as any).compartments : null;
            label = comp?.cavity_label ?? '?';
            unit_name = comp?.housing_units?.name ?? '';
          }
          Ages.push({
            compartment_id:    cid,
            label,
            unit_name,
            confirmed_male:    ageData?.male_age ?? null,
            confirmed_female:  ageData?.female_age ?? null,
            male_observations:   obsData?.male ?? [],
            female_observations: obsData?.female ?? [],
          });
        }
        Ages.sort((a, b) => {
          const u = a.unit_name.localeCompare(b.unit_name);
          return u !== 0 ? u : a.label.localeCompare(b.label);
        });
        setAdultAges(Ages);

        if (!Entries) { setNestProgress([]); return; }

        // Count banded nestlings per (compartment_id, nesting_attempt) so the histogram
        // shows only birds that still need a band.
        const BandedByKey = new Map<string, number>();
        const EntryIdList = (Entries as any[]).map(e => e.id).filter(Boolean);
        if (EntryIdList.length > 0) {
          const { data: BandRows } = await supabase
            .from('bands')
            .select('nest_check_entry_id, nestling_id')
            .in('nest_check_entry_id', EntryIdList)
            .eq('bird_type', 'nestling')
            .eq('is_new_banding', true)
            .not('nestling_id', 'is', null);
          if (BandRows) {
            const EntryKeyMap = new Map(
              (Entries as any[]).map(e => [e.id, `${e.compartment_id}:${e.nesting_attempt ?? 1}`])
            );
            const BandedSets = new Map<string, Set<string>>();
            for (const B of BandRows) {
              const key = EntryKeyMap.get(B.nest_check_entry_id);
              if (!key || !B.nestling_id) continue;
              if (!BandedSets.has(key)) BandedSets.set(key, new Set());
              BandedSets.get(key)!.add(B.nestling_id);
            }
            for (const [key, set] of BandedSets) BandedByKey.set(key, set.size);
          }
        }

        // Entries that only carry adult age observations (no nest status, eggs, or young) must be
        // excluded from nest-progress and banding-window logic — they don't represent a nest check.
        const hasNestData = (E: any) =>
          E.is_empty_cavity || E.has_nest ||
          (E.egg_count ?? 0) > 0 || (E.young_count ?? 0) > 0 ||
          (E.fledged_count ?? 0) > 0 || (E.dead_young_count ?? 0) > 0;

        // Full check history per compartment (all attempts, sorted ascending) for RA first-egg uncertainty.
        // Stores egg_count alongside date so the trough's count can inform how far back to look.
        type CheckSnapshot = { check_date: string; egg_count: number; discarded_eggs: number };
        const AllHistoryByCompartment = new Map<string, CheckSnapshot[]>();
        for (const E of Entries) {
          const Chk = Checks.find(c => c.id === E.nest_check_id);
          if (!Chk) continue;
          if (!(E as any).adult_present && hasNestData(E)) {
            if (!AllHistoryByCompartment.has(E.compartment_id)) AllHistoryByCompartment.set(E.compartment_id, []);
            const hist = AllHistoryByCompartment.get(E.compartment_id)!;
            if (!hist.some(h => h.check_date === Chk.check_date))
              hist.push({ check_date: Chk.check_date, egg_count: E.egg_count ?? 0, discarded_eggs: (E as any).discarded_eggs ?? 0 });
          }
        }
        for (const [id, hist] of AllHistoryByCompartment)
          AllHistoryByCompartment.set(id, hist.sort((a, b) => a.check_date.localeCompare(b.check_date)));

        // Group entries by (compartment, nesting_attempt)
        type CompKey = string; // `${compartment_id}:${nesting_attempt}`
        const CompMap = new Map<CompKey, { compartment_id: string; label: string; unit_name: string; nesting_attempt: number; ewd: { check_date: string; egg_count: number; young_count: number; nestling_age_days: number | null; fledged_count: number; dead_young_count: number }[] }>();
        for (const E of Entries) {
          const Chk = Checks.find(c => c.id === E.nest_check_id);
          if (!Chk) continue;
          const comp = E.compartments as any;
          if (!comp) continue;
          const NestingAttempt = (E as any).nesting_attempt ?? 1;
          const CompKey = `${E.compartment_id}:${NestingAttempt}`;
          if (!CompMap.has(CompKey)) {
            CompMap.set(CompKey, {
              compartment_id: E.compartment_id,
              label:          comp.cavity_label as string,
              unit_name:      (comp.housing_units as any)?.name as string ?? '',
              nesting_attempt:  NestingAttempt,
              ewd:            [],
            });
          }
          if (!(E as any).adult_present && hasNestData(E)) {
            CompMap.get(CompKey)!.ewd.push({
              check_date:        Chk.check_date,
              egg_count:         E.egg_count ?? 0,
              young_count:       E.young_count ?? 0,
              nestling_age_days: E.nestling_age_days,
              fledged_count:     (E as any).fledged_count ?? 0,
              dead_young_count:  (E as any).dead_young_count ?? 0,
            });
          }
        }

        // Compute projections per (compartment, nesting_attempt)
        const Progress: CompartmentProgress[] = [];
        let StatEggs = 0, StatHatched = 0, StatFledged = 0;
        for (const [, Data] of CompMap) {
          if (!Data.ewd.some(e => e.egg_count > 0 || e.young_count > 0)) continue;

          StatEggs    += Math.max(0, ...Data.ewd.map(e => e.egg_count));
          StatHatched += Math.max(0, ...Data.ewd.map(e => e.young_count + e.dead_young_count));
          StatFledged += Math.max(0, ...Data.ewd.map(e => e.fledged_count));

          const EWD = [...Data.ewd].sort((a, b) => a.check_date.localeCompare(b.check_date));
          let FirstEggMin: string | null = null, FirstEggMax: string | null = null;
          let ProjHatchMin: string | null = null, ProjHatchMax: string | null = null;
          let ActualHatch: string | null = null, ProjFledge: string | null = null;

          const FirstWithEggs = EWD.find(e => e.egg_count > 0);
          if (FirstWithEggs) {
            const LatestFirst = addDays(FirstWithEggs.check_date, -(FirstWithEggs.egg_count - 1));
            let EarliestFirst: string | null = null;
            if (Data.nesting_attempt === 1) {
              // First attempt: last check with 0 eggs gives the earliest-possible date
              const LastEmpty = [...EWD].filter(e => e.egg_count === 0 && e.check_date < FirstWithEggs.check_date).pop();
              EarliestFirst = LastEmpty ? addDays(LastEmpty.check_date, 1) : null;
            } else {
              // Renesting: the trough check (last check before first RA egg) may itself contain
              // new eggs laid alongside sterile old ones, so the true first new egg could predate it.
              // - If trough egg count === 0: no new eggs existed yet → lower bound is day after trough.
              // - If trough egg count > 0: trough eggs may be partly new → go back one more check.
              const Hist = AllHistoryByCompartment.get(Data.compartment_id) ?? [];
              const Before = Hist.filter(h => h.check_date < FirstWithEggs.check_date);
              const Trough = Before[Before.length - 1] ?? null;
              if (!Trough) {
                EarliestFirst = null;
              } else {
                const TroughNet = Math.max(0, Trough.egg_count - Trough.discarded_eggs);
                if (TroughNet === 0) {
                  EarliestFirst = addDays(Trough.check_date, 1);
                } else {
                  const PreTrough = Before[Before.length - 2] ?? null;
                  EarliestFirst = addDays(PreTrough ? PreTrough.check_date : Trough.check_date, 1);
                }
              }
            }
            const MinFirst = (EarliestFirst && EarliestFirst <= LatestFirst) ? EarliestFirst : LatestFirst;
            FirstEggMin = MinFirst; FirstEggMax = LatestFirst;
            const MaxEggs = Math.max(...EWD.map(e => e.egg_count));
            ProjHatchMin = addDays(MinFirst,    MaxEggs - 1 + 15);
            ProjHatchMax = addDays(LatestFirst, MaxEggs - 1 + 15);
          }

          const Anchor = EWD.find(e => e.young_count > 0 && e.nestling_age_days != null);
          if (Anchor) {
            const [ay, am, ad] = Anchor.check_date.split('-').map(Number);
            const Hatch = new Date(ay, am - 1, ad);
            Hatch.setDate(Hatch.getDate() - Anchor.nestling_age_days!);
            ActualHatch = `${Hatch.getFullYear()}-${String(Hatch.getMonth() + 1).padStart(2, '0')}-${String(Hatch.getDate()).padStart(2, '0')}`;
            ProjFledge  = addDays(ActualHatch, 26);
          }

          const Ages = AgeMap.get(Data.compartment_id);
          // Use the last recorded young_count — if young disappeared after hatching, they're excluded from banding
          const YoungCount = EWD[EWD.length - 1]?.young_count ?? 0;
          const BandedCount = BandedByKey.get(`${Data.compartment_id}:${Data.nesting_attempt}`) ?? 0;
          const AttemptSuffix = Data.nesting_attempt > 1 ? ` (Attempt ${Data.nesting_attempt})` : '';
          const FleddgeDates = EWD.filter(e => e.fledged_count > 0).map(e => e.check_date).sort();
          Progress.push({ compartment_id: Data.compartment_id, nesting_attempt: Data.nesting_attempt, label: Data.label + AttemptSuffix, unit_name: Data.unit_name, first_egg_min: FirstEggMin, first_egg_max: FirstEggMax, proj_hatch_min: ProjHatchMin, proj_hatch_max: ProjHatchMax, actual_hatch: ActualHatch, proj_fledge: ProjFledge, fledge_dates: FleddgeDates, male_age: Ages?.male_age ?? null, female_age: Ages?.female_age ?? null, young_count: YoungCount, banded_count: BandedCount, superseded: false });
        }

        // Add non-PM compartments that have nesting activity and aren't already in Progress
        const PMCompartmentIds = new Set(Progress.map(p => p.compartment_id));
        const NonPMCompartments = new Map<string, { compartment_id: string; label: string; unit_name: string }>();
        for (const E of (NonPMResult.data ?? []) as any[]) {
          if (PMCompartmentIds.has(E.compartment_id)) continue;
          if (E.is_empty_cavity || E.adult_present) continue;
          if (!E.has_nest && (E.egg_count ?? 0) === 0 && (E.young_count ?? 0) === 0) continue;
          if (!E.compartments) continue;
          if (!NonPMCompartments.has(E.compartment_id)) {
            NonPMCompartments.set(E.compartment_id, {
              compartment_id: E.compartment_id,
              label:     (E.compartments as any).cavity_label ?? '?',
              unit_name: (E.compartments as any).housing_units?.name ?? '',
            });
          }
        }
        for (const [, C] of NonPMCompartments) {
          Progress.push({
            compartment_id: C.compartment_id, nesting_attempt: 1,
            label: C.label, unit_name: C.unit_name,
            first_egg_min: null, first_egg_max: null,
            proj_hatch_min: null, proj_hatch_max: null,
            actual_hatch: null, proj_fledge: null, fledge_dates: [],
            male_age: null, female_age: null,
            young_count: 0, banded_count: 0, superseded: false,
          });
        }

        // Mark earlier attempts as superseded when a higher attempt exists for the same compartment
        const MaxAttempt = new Map<string, number>();
        for (const P of Progress) {
          const cur = MaxAttempt.get(P.compartment_id) ?? 0;
          if (P.nesting_attempt > cur) MaxAttempt.set(P.compartment_id, P.nesting_attempt);
        }
        for (const P of Progress) {
          if (P.nesting_attempt < (MaxAttempt.get(P.compartment_id) ?? P.nesting_attempt)) P.superseded = true;
        }

        setNestProgress(Progress.sort((a, b) => {
          const u = labelCompare(a.unit_name, b.unit_name);
          return u !== 0 ? u : labelCompare(a.label, b.label);
        }));
        setColonyStats(Progress.length > 0 ? { eggs: StatEggs, hatched: StatHatched, fledged: StatFledged } : null);
      }

      async function loadBands() {
        const { data: Chks } = await supabase
          .from('nest_checks')
          .select('id, check_date')
          .eq('site_id', SiteId);
        if (!Chks?.length) { setAllBandsData([]); return; }

        const CheckMap = new Map((Chks as any[]).map(c => [c.id as string, c.check_date as string]));
        const { data: Ents } = await supabase
          .from('nest_check_entries')
          .select('id, nest_check_id, compartments(cavity_label, housing_units(name))')
          .in('nest_check_id', Chks.map(c => c.id));
        if (!Ents?.length) { setAllBandsData([]); return; }

        const EntMap = new Map((Ents as any[]).map(e => [e.id as string, e]));
        const { data: Bands } = await supabase
          .from('bands')
          .select('nest_check_entry_id, nestling_id, bird_type, is_new_banding, band_type, band_color, band_code')
          .in('nest_check_entry_id', Ents.map(e => (e as any).id));

        const Rows: BandRow[] = [];
        for (const B of (Bands ?? []) as any[]) {
          const Ent = EntMap.get(B.nest_check_entry_id);
          if (!Ent) continue;
          const CheckDate = CheckMap.get(Ent.nest_check_id);
          if (!CheckDate) continue;
          const comp = Ent.compartments as any;
          Rows.push({
            year:                parseInt(CheckDate.substring(0, 4), 10),
            compartment_label:   comp?.cavity_label ?? '',
            unit_name:           comp?.housing_units?.name ?? '',
            check_date:          CheckDate,
            band_type:           B.band_type,
            band_color:          B.band_color ?? null,
            band_code:           B.band_code,
            bird_type:           B.bird_type,
            is_new_banding:      !!B.is_new_banding,
            nestling_id:         B.nestling_id ?? null,
            nest_check_entry_id: B.nest_check_entry_id,
          });
        }

        Rows.sort((a, b) => {
          if (a.year !== b.year) return a.year - b.year;
          const u = a.unit_name.localeCompare(b.unit_name);
          if (u !== 0) return u;
          const l = labelCompare(a.compartment_label, b.compartment_label);
          if (l !== 0) return l;
          return a.check_date.localeCompare(b.check_date);
        });
        setAllBandsData(Rows);
      }

      loadAll();
      loadBands();
      loadHousing();
    }, [SeasonId, SiteId, Year])
  );

  // ── Housing ────────────────────────────────────────────────────────
  async function loadHousing() {
    setCopyHousingSourceId(null);
    setCopyHousingSourceYear(null);
    setCopyHousingIsLegacy(false);

    // Try season-specific housing first
    const { data: HUnits } = await supabase
      .from('housing_units')
      .select('id, name, unit_type, default_hole_type')
      .eq('site_season_id', SeasonId)
      .order('name');

    if (HUnits && HUnits.length > 0) {
      setSeasonHousingUnits(HUnits);
      setHousingIsLegacy(false);
      return;
    }

    // No season-specific housing — show legacy (site-scoped) housing directly.
    // Legacy housing is what existing nest check entries reference, so it must
    // be displayed as-is rather than offered as a copy source.
    const { data: LegacyUnits } = await supabase
      .from('housing_units')
      .select('id, name, unit_type, default_hole_type')
      .eq('site_id', SiteId)
      .is('site_season_id', null)
      .order('name');

    if (LegacyUnits && LegacyUnits.length > 0) {
      setSeasonHousingUnits(LegacyUnits);
      setHousingIsLegacy(true);
      return;
    }

    // Nothing at all — find the best copy source from another season
    setSeasonHousingUnits([]);
    setHousingIsLegacy(false);

    const { data: OtherSeasoned } = await supabase
      .from('housing_units')
      .select('site_season_id')
      .eq('site_id', SiteId)
      .not('site_season_id', 'is', null)
      .neq('site_season_id', SeasonId);

    if (OtherSeasoned && OtherSeasoned.length > 0) {
      const OtherIds = [...new Set(OtherSeasoned.map((U: any) => U.site_season_id))];
      const { data: OtherSeasons } = await supabase
        .from('site_seasons')
        .select('id, year')
        .in('id', OtherIds)
        .order('year', { ascending: false })
        .limit(1);
      if (OtherSeasons && OtherSeasons.length > 0) {
        setCopyHousingSourceId(OtherSeasons[0].id);
        setCopyHousingSourceYear(OtherSeasons[0].year);
        return;
      }
    }
  }

  async function cloneHousingFromSeason() {
    setCopyingHousing(true);
    try {
      let query = supabase
        .from('housing_units')
        .select('id, name, unit_type, default_hole_type, compartments(cavity_label, housing_type, hole_type, sort_order)');
      if (CopyHousingIsLegacy) {
        query = (query as any).eq('site_id', SiteId).is('site_season_id', null);
      } else {
        query = (query as any).eq('site_season_id', CopyHousingSourceId);
      }
      const { data: Units } = await query;
      if (!Units || Units.length === 0) return;

      for (const Unit of Units as any[]) {
        const { data: NewUnit } = await supabase
          .from('housing_units')
          .insert({ site_id: SiteId, site_season_id: SeasonId, name: Unit.name, unit_type: Unit.unit_type, default_hole_type: Unit.default_hole_type })
          .select('id')
          .single();
        if (NewUnit && Unit.compartments && Unit.compartments.length > 0) {
          await supabase.from('compartments').insert(
            (Unit.compartments as any[]).map((C: any) => ({
              housing_unit_id: NewUnit.id,
              site_season_id: SeasonId,
              cavity_label: C.cavity_label,
              housing_type: C.housing_type,
              hole_type: C.hole_type,
              sort_order: C.sort_order,
            }))
          );
        }
      }
      await loadHousing();
    } catch {
      Alert.alert('Copy failed', 'Could not copy housing. Please try again.');
    } finally {
      setCopyingHousing(false);
    }
  }

  function handleCopyHousing() {
    const sourceName = CopyHousingIsLegacy
      ? 'your previous housing setup'
      : `the ${CopyHousingSourceYear} season`;
    Alert.alert(
      'Copy Housing',
      `Copy all housing units and compartments from ${sourceName} to this season?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Copy', onPress: cloneHousingFromSeason },
      ]
    );
  }

  async function openCompartmentHistory(compartmentId: string, label: string) {
    setCompartmentHistoryLabel(label);
    setCompartmentHistoryId(compartmentId);
    setCompartmentHistoryLoading(true);
    setCompartmentHistoryEntries([]);
    const checkIds = NestChecks.map(c => c.id);
    if (checkIds.length > 0) {
      const { data } = await supabase
        .from('nest_check_entries')
        .select('nest_check_id, species, egg_count, discarded_eggs, young_count, nestling_age_days, fledged_count, dead_young_count, dead_adult_male, dead_adult_female, has_nest, nest_replaced, is_empty_cavity, adult_present, nest_discarded, nesting_attempt')
        .eq('compartment_id', compartmentId)
        .in('nest_check_id', checkIds);
      const CheckMap = new Map(NestChecks.map(c => [c.id, c.check_date]));
      const entries: HistoryEntry[] = (data ?? []).map((E: any) => ({
        check_date:        CheckMap.get(E.nest_check_id) ?? '',
        species:           E.species,
        egg_count:         E.egg_count ?? 0,
        discarded_eggs:    E.discarded_eggs ?? 0,
        young_count:       E.young_count ?? 0,
        nestling_age_days: E.nestling_age_days,
        fledged_count:     E.fledged_count ?? 0,
        dead_young_count:  E.dead_young_count ?? 0,
        dead_adult_male:   !!E.dead_adult_male,
        dead_adult_female: !!E.dead_adult_female,
        has_nest:          !!E.has_nest,
        nest_replaced:     !!E.nest_replaced,
        is_empty_cavity:   !!E.is_empty_cavity,
        adult_present:     !!E.adult_present,
        nest_discarded:    !!E.nest_discarded,
        nesting_attempt:   E.nesting_attempt ?? 1,
      })).filter(e => e.check_date).sort((a, b) =>
        a.check_date.localeCompare(b.check_date) || a.nesting_attempt - b.nesting_attempt
      );
      setCompartmentHistoryEntries(entries);
    }
    setCompartmentHistoryLoading(false);
  }

  // ── Save arrival dates ─────────────────────────────────────────────
  async function handleSaveDates() {
    setDatesLoading(true);
    setDatesError('');
    const { error } = await supabase
      .from('site_seasons')
      .update({
        date_first_asy_seen:    FirstAsySeen.trim() || null,
        date_first_sy_male_seen: FirstSyMaleSeen.trim() || null,
      })
      .eq('id', SeasonId);
    setDatesLoading(false);
    if (error) setDatesError(friendlyError(error, 'Failed to save dates.'));
  }

  function saveBandingWindow() {
    const minVal = parseInt(BandingMinText, 10);
    const maxVal = parseInt(BandingMaxText, 10);
    if (isNaN(minVal) || isNaN(maxVal) || minVal < 1 || maxVal < minVal) return;
    setBandingMin(minVal);
    setBandingMax(maxVal);
    setSelectedBandingDate(null);
    AsyncStorage.setItem(`banding_min_${SiteId}`, String(minVal));
    AsyncStorage.setItem(`banding_max_${SiteId}`, String(maxVal));
  }

  // ── Add nest check ─────────────────────────────────────────────────
  function handleDeleteSeasonPress() {
    if (NestChecks.length === 0) {
      doDeleteSeason();
    } else {
      setDeleteSeasonError('');
      setDeleteSeasonVisible(true);
    }
  }

  async function doDeleteSeason() {
    setDeletingSeason(true);
    setDeleteSeasonError('');
    try {
      // Verify permission before touching any data — fail fast if RLS would block the season delete
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated.');
      const { data: Site } = await supabase.from('sites').select('owner_id').eq('id', SiteId).maybeSingle();
      const { data: Member } = await supabase.from('site_members').select('role').eq('site_id', SiteId).eq('user_id', user.id).maybeSingle();
      if (Site?.owner_id !== user.id && Member?.role !== 'manager') {
        throw new Error('Only the site owner or a manager can delete a season.');
      }

      // Query all checks for this season by date range — don't rely on NestChecks state
      const { data: CheckRows, error: CheckFetchErr } = await supabase
        .from('nest_checks')
        .select('id')
        .eq('site_id', SiteId)
        .gte('check_date', `${Year}-01-01`)
        .lte('check_date', `${Year}-12-31`);
      if (CheckFetchErr) throw new Error(`Fetch checks: ${CheckFetchErr.message}`);
      const CheckIds = (CheckRows ?? []).map(c => c.id);
      if (CheckIds.length > 0) {
        const { data: EntryRows, error: EntryFetchErr } = await supabase
          .from('nest_check_entries').select('id').in('nest_check_id', CheckIds);
        if (EntryFetchErr) throw new Error(`Fetch entries: ${EntryFetchErr.message}`);
        const EntryIds = (EntryRows ?? []).map(e => e.id);
        if (EntryIds.length > 0) {
          const { error: BandErr } = await supabase.from('bands').delete().in('nest_check_entry_id', EntryIds);
          if (BandErr) throw new Error(`Delete bands: ${BandErr.message}`);
          const { error: EntryErr } = await supabase.from('nest_check_entries').delete().in('id', EntryIds);
          if (EntryErr) throw new Error(`Delete entries: ${EntryErr.message}`);
        }
        const { error: CheckErr } = await supabase.from('nest_checks').delete().in('id', CheckIds);
        if (CheckErr) throw new Error(`Delete checks: ${CheckErr.message}`);
      }
      const { error: NsErr } = await supabase.from('nest_seasons').delete().eq('site_season_id', SeasonId);
      if (NsErr) throw new Error(`Delete nest_seasons: ${NsErr.message}`);
      const { error: NlErr } = await supabase.from('nestlings').delete().eq('site_season_id', SeasonId);
      if (NlErr) throw new Error(`Delete nestlings: ${NlErr.message}`);
      const { error: SsErr } = await supabase.from('site_seasons').delete().eq('id', SeasonId);
      if (SsErr) throw new Error(`Delete site_seasons: ${SsErr.message}`);
      setDeleteSeasonVisible(false);
      navigation.goBack();
    } catch (e: any) {
      setDeletingSeason(false);
      console.error(e);
      const msg = 'Failed to delete season. Please try again.';
      setDeleteSeasonError(msg);
      Alert.alert('Delete failed', msg);
    }
  }

  function openAddCheck(date?: string) {
    const currentYear = new Date().getFullYear();
    const defaultDate = Year === currentYear ? todayString() : `${Year}-06-01`;
    setNewCheckDate(date ?? defaultDate);
    setAddCheckError('');
    setAddCheckVisible(true);
  }

  async function createAndNavigateToCheck(DateVal: string): Promise<void> {
    if (AddCheckLoading) return;
    setAddCheckLoading(true);

    const { data: { user } } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
    const CheckId = makeId();

    // Try local-first (native); fall back to direct Supabase write on web
    let savedLocally = false;
    try {
      await insertLocalNestCheck({ id: CheckId, site_id: SiteId, check_date: DateVal, created_by: user?.id ?? null });
      savedLocally = true;
      syncNow().catch(() => {});
    } catch {}

    if (!savedLocally) {
      const { error } = await supabase.from('nest_checks')
        .insert({ id: CheckId, site_id: SiteId, check_date: DateVal, created_by: user?.id ?? null });
      if (error) { setAddCheckError(friendlyError(error, 'Failed to create check.')); setAddCheckLoading(false); return; }
    }

    setAddCheckLoading(false);
    setAddCheckVisible(false);
    navigation.navigate('NestCheckDetail', {
      CheckId,
      CheckDate: DateVal,
      SiteId,
      SeasonId,
      Year,
    });
  }

  async function handleAddCheck() {
    const DateVal = NewCheckDate.trim();
    if (!DateVal) { setAddCheckError('Please enter a date.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(DateVal)) {
      setAddCheckError('Use YYYY-MM-DD format, e.g. 2026-06-01.');
      return;
    }
    if (parseInt(DateVal.slice(0, 4), 10) !== Year) {
      setAddCheckError(`Date must be in the ${Year} season (year must be ${Year}).`);
      return;
    }
    await createAndNavigateToCheck(DateVal);
  }

  const BandingData = useMemo(() => {
    const counts = new Map<string, number>();
    for (const P of NestProgress) {
      const hatch = P.actual_hatch ?? P.proj_hatch_min;
      const unbanded = Math.max(0, P.young_count - P.banded_count);
      if (!hatch || unbanded <= 0) continue;
      for (let day = BandingMin; day <= BandingMax; day++) {
        const date = addDays(hatch, day);
        counts.set(date, (counts.get(date) ?? 0) + unbanded);
      }
    }
    return [...counts.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [NestProgress, BandingMin, BandingMax]);

  const MarkedDates = Object.fromEntries(
    NestChecks.map(c => [c.check_date, { selected: true, selectedColor: '#7b1fa2' }])
  );
  const _today = new Date();
  const _isCurrent = Year === _today.getFullYear() && _today <= new Date(Year, 7, 31);
  const InitialDate = _isCurrent
    ? todayString()
    : NestChecks.length > 0 ? NestChecks[0].check_date : `${Year}-04-01`;

  return (
    <>
      <View style={styles.Container}>
        {SeasonCalendarView ? (
          <ScrollView contentContainerStyle={styles.CalendarScroll}>
            {ColonyStats && (
              <View style={styles.ColonyStatsRow}>
                <View style={styles.ColonyStat}>
                  <Text style={styles.ColonyStatNum}>{ColonyStats.eggs}</Text>
                  <Text style={styles.ColonyStatLabel}>eggs laid</Text>
                </View>
                <View style={styles.ColonyStat}>
                  <Text style={styles.ColonyStatNum}>{ColonyStats.hatched}</Text>
                  <Text style={styles.ColonyStatLabel}>hatched</Text>
                </View>
                <View style={styles.ColonyStat}>
                  <Text style={styles.ColonyStatNum}>{ColonyStats.fledged}</Text>
                  <Text style={styles.ColonyStatLabel}>fledged</Text>
                </View>
              </View>
            )}
            <Calendar
              initialDate={InitialDate}
              markedDates={MarkedDates}
              onDayPress={(day) => {
                const Check = NestChecks.find(c => c.check_date === day.dateString);
                if (Check) {
                  navigation.navigate('NestCheckDetail', {
                    CheckId: Check.id, CheckDate: Check.check_date,
                    SiteId, SeasonId, Year,
                  });
                } else {
                  openAddCheck(day.dateString);
                }
              }}
              theme={{
                todayTextColor: '#6750a4',
                arrowColor: '#6750a4',
              }}
            />

            {/* ── Housing ── */}
            <Button
              mode="text"
              compact
              icon={HousingExpanded ? 'chevron-up' : 'chevron-down'}
              contentStyle={styles.ExpandBtnContent}
              onPress={() => setHousingExpanded(!HousingExpanded)}
              style={styles.ExpandBtn}
            >
              Housing
            </Button>
            {HousingExpanded && (
              <View style={styles.HousingSection}>
                {SeasonHousingUnits.length === 0 ? (
                  <Text variant="bodySmall" style={styles.Hint}>No housing set up for this season.</Text>
                ) : (
                  <>
                    {HousingIsLegacy && (
                      <Text variant="bodySmall" style={styles.Hint}>Shared housing (not yet season-specific)</Text>
                    )}
                    {SeasonHousingUnits.map(U => (
                      <Card key={U.id} style={styles.Card} mode="outlined"
                        onPress={() => navigation.navigate('HousingUnitDetail', { UnitId: U.id, UnitName: U.name, UnitType: U.unit_type, DefaultHoleType: U.default_hole_type, SeasonId })}
                      >
                        <Card.Title title={U.name} subtitle={UnitTypeLabel[U.unit_type] ?? U.unit_type} />
                      </Card>
                    ))}
                  </>
                )}
                {(CopyHousingSourceId || CopyHousingIsLegacy) && SeasonHousingUnits.length === 0 && (
                  <Button mode="outlined" compact loading={CopyingHousing} style={styles.HousingBtn} onPress={handleCopyHousing}>
                    Copy from {CopyHousingIsLegacy ? 'previous setup' : `${CopyHousingSourceYear} season`}
                  </Button>
                )}
                <Button mode="outlined" compact icon="plus" style={styles.HousingBtn}
                  onPress={() => navigation.navigate('CreateHousingUnit', { SiteId, SeasonId })}
                >
                  Add Housing Unit
                </Button>
              </View>
            )}

            {/* ── Arrival dates ── */}
            <Button
              mode="text"
              compact
              icon={ArrivalDatesExpanded ? 'chevron-up' : 'chevron-down'}
              contentStyle={styles.ExpandBtnContent}
              onPress={() => setArrivalDatesExpanded(!ArrivalDatesExpanded)}
              style={styles.ExpandBtn}
            >
              Arrival Dates
            </Button>
            {ArrivalDatesExpanded && (
              <>
                <Text variant="bodySmall" style={styles.Hint}>
                  ASY = After Second Year (adult).  SY = Second Year (yearling male).
                </Text>
                <DateInput
                  label="First ASY seen"
                  value={FirstAsySeen}
                  onChange={setFirstAsySeen}
                  style={styles.Input}
                />
                <DateInput
                  label="First SY male seen"
                  value={FirstSyMaleSeen}
                  onChange={setFirstSyMaleSeen}
                  style={styles.Input}
                />
                {DatesError ? <HelperText type="error" visible>{DatesError}</HelperText> : null}
                <Button
                  mode="outlined"
                  compact
                  loading={DatesLoading}
                  onPress={handleSaveDates}
                  style={styles.SaveDatesBtn}
                >
                  Save dates
                </Button>
              </>
            )}

            {/* ── Nest progress ── */}
            {NestProgress.length > 0 && (
              <>
                <Button
                  mode="text"
                  compact
                  icon={NestProgressExpanded ? 'chevron-up' : 'chevron-down'}
                  contentStyle={styles.ExpandBtnContent}
                  onPress={() => setNestProgressExpanded(!NestProgressExpanded)}
                  style={styles.ExpandBtn}
                >
                  Nest Progress
                </Button>
                {NestProgressExpanded && (
                  <>
                    {NestProgress.map((P) => (
                      <TouchableRipple
                        key={`${P.compartment_id}:${P.nesting_attempt}`}
                        onPress={() => openCompartmentHistory(P.compartment_id, `${P.unit_name} · ${P.label}`)}
                        style={styles.ProgressRow}
                      >
                        <View>
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={[styles.ProgressTitle, { flex: 1 }]}>{P.unit_name} · {P.label}</Text>
                            <Icon source="history" size={15} color="#9c27b0" />
                          </View>
                          <Text style={styles.ProgressDates}>{progressLine(P)}</Text>
                        </View>
                      </TouchableRipple>
                    ))}
                  </>
                )}
              </>
            )}

            {/* ── Adult ages ── */}
            {AdultAges.length > 0 && (
              <>
                <Button
                  mode="text"
                  compact
                  icon={AdultAgesExpanded ? 'chevron-up' : 'chevron-down'}
                  contentStyle={styles.ExpandBtnContent}
                  onPress={() => setAdultAgesExpanded(!AdultAgesExpanded)}
                  style={styles.ExpandBtn}
                >
                  Adult Ages
                </Button>
                {AdultAgesExpanded && AdultAges.map((A) => (
                  <View key={A.compartment_id} style={styles.ProgressRow}>
                    <Text style={styles.ProgressTitle}>{A.unit_name} · {A.label}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 }}>
                      <AgeGenderDisplay symbol="♂" confirmed={A.confirmed_male} observations={A.male_observations} onIconPress={() => setAgeConfirmInfoVisible(true)} />
                      <AgeGenderDisplay symbol="♀" confirmed={A.confirmed_female} observations={A.female_observations} onIconPress={() => setAgeConfirmInfoVisible(true)} />
                    </View>
                  </View>
                ))}
              </>
            )}

            {/* ── Banding Window ── */}
            {BandingEnabled && (
              <>
                <Button
                  mode="text"
                  compact
                  icon={BandingExpanded ? 'chevron-up' : 'chevron-down'}
                  contentStyle={styles.ExpandBtnContent}
                  onPress={() => setBandingExpanded(!BandingExpanded)}
                  style={styles.ExpandBtn}
                >
                  Banding Window
                </Button>
                {BandingExpanded && (
                  <>
                    <View style={styles.BandingWindowRow}>
                      <Text style={styles.BandingWindowLabel}>Window (days):</Text>
                      <TextInput
                        mode="outlined"
                        label="Min"
                        value={BandingMinText}
                        onChangeText={setBandingMinText}
                        keyboardType="number-pad"
                        style={styles.BandingWindowInput}
                        dense
                      />
                      <Text style={styles.BandingWindowSep}>–</Text>
                      <TextInput
                        mode="outlined"
                        label="Max"
                        value={BandingMaxText}
                        onChangeText={setBandingMaxText}
                        keyboardType="number-pad"
                        style={styles.BandingWindowInput}
                        dense
                      />
                      <Button compact mode="outlined" onPress={saveBandingWindow} style={styles.BandingWindowSaveBtn}>
                        Save
                      </Button>
                    </View>
                    <BandingHistogram
                      bars={BandingData} today={todayString()}
                      selectedDate={SelectedBandingDate}
                      onBarPress={setSelectedBandingDate}
                    />
                    <BandingCompartmentList
                      progress={NestProgress}
                      date={SelectedBandingDate ?? todayString()}
                      today={todayString()}
                      min={BandingMin} max={BandingMax}
                    />
                  </>
                )}
                {/* ── Bands ── */}
                <Button
                  mode="text"
                  compact
                  icon={BandsExpanded ? 'chevron-up' : 'chevron-down'}
                  contentStyle={styles.ExpandBtnContent}
                  onPress={() => setBandsExpanded(!BandsExpanded)}
                  style={styles.ExpandBtn}
                >
                  Bands
                </Button>
                {BandsExpanded && <BandsList rows={AllBandsData} />}
              </>
            )}
          </ScrollView>
        ) : (
        <FlatList
          data={NestChecks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.List}
          ListHeaderComponent={(
            <View>
              {ColonyStats && (
                <View style={styles.ColonyStatsRow}>
                  <View style={styles.ColonyStat}>
                    <Text style={styles.ColonyStatNum}>{ColonyStats.eggs}</Text>
                    <Text style={styles.ColonyStatLabel}>eggs laid</Text>
                  </View>
                  <View style={styles.ColonyStat}>
                    <Text style={styles.ColonyStatNum}>{ColonyStats.hatched}</Text>
                    <Text style={styles.ColonyStatLabel}>hatched</Text>
                  </View>
                  <View style={styles.ColonyStat}>
                    <Text style={styles.ColonyStatNum}>{ColonyStats.fledged}</Text>
                    <Text style={styles.ColonyStatLabel}>fledged</Text>
                  </View>
                </View>
              )}
              {/* ── Housing ── */}
              <Button
                mode="text"
                compact
                icon={HousingExpanded ? 'chevron-up' : 'chevron-down'}
                contentStyle={styles.ExpandBtnContent}
                onPress={() => setHousingExpanded(!HousingExpanded)}
                style={styles.ExpandBtn}
              >
                Housing
              </Button>
              {HousingExpanded && (
                <View style={styles.HousingSection}>
                  {SeasonHousingUnits.length === 0 ? (
                    <Text variant="bodySmall" style={styles.Hint}>No housing set up for this season.</Text>
                  ) : (
                    SeasonHousingUnits.map(U => (
                      <Card key={U.id} style={styles.Card} mode="outlined"
                        onPress={() => navigation.navigate('HousingUnitDetail', { UnitId: U.id, UnitName: U.name, UnitType: U.unit_type, DefaultHoleType: U.default_hole_type, SeasonId })}
                      >
                        <Card.Title title={U.name} subtitle={UnitTypeLabel[U.unit_type] ?? U.unit_type} />
                      </Card>
                    ))
                  )}
                  {(CopyHousingSourceId || CopyHousingIsLegacy) && SeasonHousingUnits.length === 0 && (
                    <Button mode="outlined" compact loading={CopyingHousing} style={styles.HousingBtn} onPress={handleCopyHousing}>
                      Copy from {CopyHousingIsLegacy ? 'previous setup' : `${CopyHousingSourceYear} season`}
                    </Button>
                  )}
                  <Button mode="outlined" compact icon="plus" style={styles.HousingBtn}
                    onPress={() => navigation.navigate('CreateHousingUnit', { SiteId, SeasonId })}
                  >
                    Add Housing Unit
                  </Button>
                </View>
              )}

              {/* ── Arrival dates ── */}
              <Button
                mode="text"
                compact
                icon={ArrivalDatesExpanded ? 'chevron-up' : 'chevron-down'}
                contentStyle={styles.ExpandBtnContent}
                onPress={() => setArrivalDatesExpanded(!ArrivalDatesExpanded)}
                style={styles.ExpandBtn}
              >
                Arrival Dates
              </Button>
              {ArrivalDatesExpanded && (
                <>
                  <Text variant="bodySmall" style={styles.Hint}>
                    ASY = After Second Year (adult).  SY = Second Year (yearling male).
                  </Text>
                  <DateInput
                    label="First ASY seen"
                    value={FirstAsySeen}
                    onChange={setFirstAsySeen}
                    style={styles.Input}
                  />
                  <DateInput
                    label="First SY male seen"
                    value={FirstSyMaleSeen}
                    onChange={setFirstSyMaleSeen}
                    style={styles.Input}
                  />
                  {DatesError ? <HelperText type="error" visible>{DatesError}</HelperText> : null}
                  <Button
                    mode="outlined"
                    compact
                    loading={DatesLoading}
                    onPress={handleSaveDates}
                    style={styles.SaveDatesBtn}
                  >
                    Save dates
                  </Button>
                </>
              )}

              {/* ── Nest progress ── */}
              {NestProgress.length > 0 && (
                <>
                  <Button
                    mode="text"
                    compact
                    icon={NestProgressExpanded ? 'chevron-up' : 'chevron-down'}
                    contentStyle={styles.ExpandBtnContent}
                    onPress={() => setNestProgressExpanded(!NestProgressExpanded)}
                    style={styles.ExpandBtn}
                  >
                    Nest Progress
                  </Button>
                  {NestProgressExpanded && (
                    <>
                      {NestProgress.map((P) => (
                        <View key={`${P.compartment_id}:${P.nesting_attempt}`} style={styles.ProgressRow}>
                          <Text style={styles.ProgressTitle}>{P.unit_name} · {P.label}</Text>
                          <Text style={styles.ProgressDates}>{progressLine(P)}</Text>
                        </View>
                      ))}
                    </>
                  )}
                </>
              )}

              {/* ── Adult ages ── */}
              {AdultAges.length > 0 && (
                <>
                  <Button
                    mode="text"
                    compact
                    icon={AdultAgesExpanded ? 'chevron-up' : 'chevron-down'}
                    contentStyle={styles.ExpandBtnContent}
                    onPress={() => setAdultAgesExpanded(!AdultAgesExpanded)}
                    style={styles.ExpandBtn}
                  >
                    Adult Ages
                  </Button>
                  {AdultAgesExpanded && AdultAges.map((A) => (
                    <View key={A.compartment_id} style={styles.ProgressRow}>
                      <Text style={styles.ProgressTitle}>{A.unit_name} · {A.label}</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 }}>
                        <AgeGenderDisplay symbol="♂" confirmed={A.confirmed_male} observations={A.male_observations} onIconPress={() => setAgeConfirmInfoVisible(true)} />
                        <AgeGenderDisplay symbol="♀" confirmed={A.confirmed_female} observations={A.female_observations} onIconPress={() => setAgeConfirmInfoVisible(true)} />
                      </View>
                    </View>
                  ))}
                </>
              )}

              {/* ── Banding Window + Bands ── */}
              {BandingEnabled && (
                <>
                  <Button
                    mode="text"
                    compact
                    icon={BandingExpanded ? 'chevron-up' : 'chevron-down'}
                    contentStyle={styles.ExpandBtnContent}
                    onPress={() => setBandingExpanded(!BandingExpanded)}
                    style={styles.ExpandBtn}
                  >
                    Banding Window
                  </Button>
                  {BandingExpanded && (
                    <>
                      <View style={styles.BandingWindowRow}>
                        <Text style={styles.BandingWindowLabel}>Window (days):</Text>
                        <TextInput
                          mode="outlined"
                          label="Min"
                          value={BandingMinText}
                          onChangeText={setBandingMinText}
                          keyboardType="number-pad"
                          style={styles.BandingWindowInput}
                          dense
                        />
                        <Text style={styles.BandingWindowSep}>–</Text>
                        <TextInput
                          mode="outlined"
                          label="Max"
                          value={BandingMaxText}
                          onChangeText={setBandingMaxText}
                          keyboardType="number-pad"
                          style={styles.BandingWindowInput}
                          dense
                        />
                        <Button compact mode="outlined" onPress={saveBandingWindow} style={styles.BandingWindowSaveBtn}>
                          Save
                        </Button>
                      </View>
                      <BandingHistogram
                        bars={BandingData} today={todayString()}
                        selectedDate={SelectedBandingDate}
                        onBarPress={setSelectedBandingDate}
                      />
                      <BandingCompartmentList
                        progress={NestProgress}
                        date={SelectedBandingDate ?? todayString()}
                        today={todayString()}
                        min={BandingMin} max={BandingMax}
                      />
                    </>
                  )}
                  <Button
                    mode="text"
                    compact
                    icon={BandsExpanded ? 'chevron-up' : 'chevron-down'}
                    contentStyle={styles.ExpandBtnContent}
                    onPress={() => setBandsExpanded(!BandsExpanded)}
                    style={styles.ExpandBtn}
                  >
                    Bands
                  </Button>
                  {BandsExpanded && <BandsList rows={AllBandsData} />}
                </>
              )}

              {/* ── Nest checks header ── */}
              <Text variant="labelLarge" style={styles.SectionHeader}>Nest checks</Text>
              {!ChecksLoading && NestChecks.length === 0 && (
                <Text variant="bodyMedium" style={styles.EmptyText}>
                  No nest checks yet. Tap + to record your first check.
                </Text>
              )}
            </View>
          )}
          renderItem={({ item }) => (
            <Card
              style={styles.Card}
              mode="outlined"
              onPress={() => navigation.navigate('NestCheckDetail', {
                CheckId:   item.id,
                CheckDate: item.check_date,
                SiteId,
                SeasonId,
                Year,
              })}
            >
              <Card.Title
                title={formatDate(item.check_date)}
                left={(props) => <List.Icon {...props} icon="clipboard-list-outline" />}
              />
            </Card>
          )}
        />
        )}

        <FAB
          icon="plus"
          style={styles.FAB}
          onPress={() => openAddCheck()}
        />
      </View>

      <Portal>
        {/* ── Delete season confirmation ─────────────────────────── */}
        <Dialog visible={DeleteSeasonVisible} onDismiss={() => setDeleteSeasonVisible(false)}>
          <Dialog.Title>Delete {Year} Season?</Dialog.Title>
          <Dialog.Content>
            <Text>
              This season has {NestChecks.length} nest {NestChecks.length === 1 ? 'check' : 'checks'}. Deleting it will permanently remove all check data. This cannot be undone.
            </Text>
            {DeleteSeasonError ? <HelperText type="error" visible>{DeleteSeasonError}</HelperText> : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteSeasonVisible(false)}>Cancel</Button>
            <Button textColor="red" loading={DeletingSeason} onPress={doDeleteSeason}>Delete</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={AgeConfirmInfoVisible} onDismiss={() => setAgeConfirmInfoVisible(false)}>
          <Dialog.Title>About Age Confirmation</Dialog.Title>
          <Dialog.Content>
            <Text>
              Age confirmation requires 3 consistent observations of an adult entering the nest.
              Until 3 matching observations have been recorded, the age is shown as unconfirmed (?).
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAgeConfirmInfoVisible(false)}>Got it</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={CompartmentHistoryId !== null} onDismiss={() => setCompartmentHistoryId(null)}>
          <Dialog.Title>{CompartmentHistoryLabel}</Dialog.Title>
          <Dialog.ScrollArea style={{ maxHeight: 400 }}>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 8 }}>
              {CompartmentHistoryLoading ? (
                <Text style={{ color: '#888', fontStyle: 'italic' }}>Loading…</Text>
              ) : CompartmentHistoryEntries.length === 0 ? (
                <Text style={{ color: '#888', fontStyle: 'italic' }}>No entries recorded for this compartment.</Text>
              ) : (
                CompartmentHistoryEntries.map((E, i) => {
                  const prev = i > 0 ? CompartmentHistoryEntries[i - 1] : null;
                  const isNewAttempt = !prev || E.nesting_attempt !== prev.nesting_attempt;
                  return (
                    <View key={i} style={{ flexDirection: 'row', marginBottom: 4 }}>
                      <Text style={{ fontSize: 13, color: '#666', width: 64 }}>{shortDate(E.check_date)}</Text>
                      <Text style={{ fontSize: 13, color: '#222', flex: 1 }}>{historyCode(E, isNewAttempt)}</Text>
                    </View>
                  );
                })
              )}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setCompartmentHistoryId(null)}>Close</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={AddCheckVisible} onDismiss={() => setAddCheckVisible(false)}>
          <Dialog.Title>New Nest Check</Dialog.Title>
          <Dialog.Content>
            <DateInput
              label="Check date"
              value={NewCheckDate}
              onChange={setNewCheckDate}
              style={styles.DialogInput}
            />
            {AddCheckError ? <HelperText type="error" visible>{AddCheckError}</HelperText> : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAddCheckVisible(false)}>Cancel</Button>
            <Button loading={AddCheckLoading} onPress={handleAddCheck}>Start Check</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  Container:      { flex: 1 },
  CalendarScroll: { padding: 16, paddingBottom: 80 },
  List:          { padding: 16, paddingBottom: 80 },
  SectionHeader:   { marginTop: 16, marginBottom: 4 },
  ExpandBtn:       { alignSelf: 'flex-start', marginTop: 8 },
  ExpandBtnContent:{ flexDirection: 'row-reverse' },
  Hint:          { color: '#666', marginBottom: 8 },
  Input:         { marginBottom: 8 },
  SaveDatesBtn:  { alignSelf: 'flex-start', marginBottom: 16 },
  Card:          { marginBottom: 8 },
  ProgressRow:   { marginBottom: 6 },
  ProgressTitle: { fontSize: 13, fontWeight: '500', color: '#222' },
  ProgressDates: { fontSize: 12, color: '#555' },
  EmptyText:     { color: '#666', marginBottom: 16 },
  FAB:           { position: 'absolute', right: 16, bottom: 16 },
  DialogInput:   { marginBottom: 8 },
  BandingWindowRow:     { flexDirection: 'row', alignItems: 'center', marginBottom: 8, marginTop: 4, flexWrap: 'wrap' },
  BandingWindowLabel:   { fontSize: 13, color: '#444', marginRight: 6 },
  BandingWindowInput:   { width: 64, marginHorizontal: 4 },
  BandingWindowSep:     { fontSize: 16, color: '#444' },
  BandingWindowSaveBtn: { marginLeft: 8 },
  HousingSection: { marginBottom: 8 },
  HousingBtn:     { marginTop: 6, alignSelf: 'flex-start' },
  ColonyStatsRow:  { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 10, marginTop: 4 },
  ColonyStat:      { alignItems: 'center' },
  ColonyStatNum:   { fontSize: 20, fontWeight: '700', color: '#7b1fa2' },
  ColonyStatLabel: { fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 },
});
