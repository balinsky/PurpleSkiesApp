import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, Dialog, FAB, HelperText, IconButton, List, Portal, Text, TextInput } from 'react-native-paper';
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
  male_age: string | null;
  female_age: string | null;
  young_count: number;
  banded_count: number;
};

function progressLine(P: CompartmentProgress): string {
  const AgeParts = [P.male_age && `♂ ${P.male_age}`, P.female_age && `♀ ${P.female_age}`].filter(Boolean).join('  ');
  const Age = AgeParts ? `  ·  ${AgeParts}` : '';
  if (P.actual_hatch) {
    const fledge = P.proj_fledge ? `  ·  Earliest Fledge ${shortDate(P.proj_fledge)}` : '';
    return `Hatched ${shortDate(P.actual_hatch)}${fledge}${Age}`;
  }
  if (!P.first_egg_min) return AgeParts;
  const eggStr = P.first_egg_min === P.first_egg_max
    ? shortDate(P.first_egg_min)
    : `${shortDate(P.first_egg_min)}–${shortDate(P.first_egg_max!)}`;
  if (!P.proj_hatch_min) return `1st egg: ${eggStr}${Age}`;
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

function BandingHistogram({ bars, today }: {
  bars: { date: string; count: number }[];
  today: string;
}) {
  if (bars.length === 0) {
    return (
      <Text style={{ color: '#888', fontSize: 12, marginBottom: 12, fontStyle: 'italic' }}>
        No nestlings with known hatch dates yet.
      </Text>
    );
  }
  const MaxCount = Math.max(...bars.map(b => b.count), 1);
  const BAR_MAX = 100;
  const BAR_W   = 44;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
      <View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: BAR_MAX + 28 }}>
          {bars.map(({ date, count }) => {
            const h = Math.max(4, Math.round((count / MaxCount) * BAR_MAX));
            const isToday = date === today;
            return (
              <View key={date} style={{ width: BAR_W, alignItems: 'center', marginHorizontal: 2 }}>
                <Text style={{ fontSize: 10, color: '#333', marginBottom: 2 }}>{count}</Text>
                <View style={{
                  width: BAR_W - 10, height: h,
                  backgroundColor: isToday ? '#e65100' : '#7b1fa2',
                  borderRadius: 3,
                }} />
              </View>
            );
          })}
        </View>
        <View style={{ flexDirection: 'row' }}>
          {bars.map(({ date }) => (
            <Text key={date} style={{ width: BAR_W, textAlign: 'center', fontSize: 9, color: '#666', marginHorizontal: 2 }}>
              {shortDate(date)}
            </Text>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

export default function SeasonDetailScreen({ navigation, route }: Props) {
  const { SeasonId, SiteId, Year } = route.params;
  const { SeasonCalendarView, toggleSeasonCalendarView } = useSettings();
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

  type AdultAge = { compartment_id: string; label: string; unit_name: string; male_age: string | null; female_age: string | null };
  const [AdultAges, setAdultAges]               = useState<AdultAge[]>([]);
  const [AdultAgesExpanded, setAdultAgesExpanded] = useState(false);

  const [BandingExpanded, setBandingExpanded]   = useState(false);
  const [BandingMin, setBandingMin]             = useState(14);
  const [BandingMax, setBandingMax]             = useState(19);
  const [BandingMinText, setBandingMinText]     = useState('14');
  const [BandingMaxText, setBandingMaxText]     = useState('19');

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

        // Fetch PM entries (nest progress) and nest seasons (adult ages) in parallel
        const [EntriesResult, NestSeasonsResult] = await Promise.all([
          supabase
            .from('nest_check_entries')
            .select('id, nest_check_id, compartment_id, adult_present, egg_count, discarded_eggs, young_count, nestling_age_days, fledged_count, dead_young_count, nesting_attempt, compartments(cavity_label, housing_units(name))')
            .in('nest_check_id', Checks.map(c => c.id))
            .eq('species', 'PM'),
          supabase
            .from('nest_seasons')
            .select('compartment_id, male_age, female_age, compartments(cavity_label, housing_units(name))')
            .eq('site_season_id', SeasonId),
        ]);
        const Entries        = EntriesResult.data;
        const NestSeasonRows = NestSeasonsResult.data;

        // Adult ages — independent of entries
        const AgeMap = new Map<string, { male_age: string | null; female_age: string | null }>();
        if (NestSeasonRows) {
          for (const NS of NestSeasonRows) AgeMap.set(NS.compartment_id, NS);
        }
        const Ages: AdultAge[] = (NestSeasonRows ?? [])
          .filter(NS => NS.male_age || NS.female_age)
          .map(NS => {
            const comp = (NS as any).compartments;
            return {
              compartment_id: NS.compartment_id,
              label:     comp?.cavity_label ?? '?',
              unit_name: comp?.housing_units?.name ?? '',
              male_age:  NS.male_age,
              female_age: NS.female_age,
            };
          })
          .sort((a, b) => {
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

        // Full check history per compartment (all attempts, sorted ascending) for RA first-egg uncertainty.
        // Stores egg_count alongside date so the trough's count can inform how far back to look.
        type CheckSnapshot = { check_date: string; egg_count: number; discarded_eggs: number };
        const AllHistoryByCompartment = new Map<string, CheckSnapshot[]>();
        for (const E of Entries) {
          const Chk = Checks.find(c => c.id === E.nest_check_id);
          if (!Chk) continue;
          if (!(E as any).adult_present) {
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
          if (!(E as any).adult_present) {
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
          Progress.push({ compartment_id: Data.compartment_id, nesting_attempt: Data.nesting_attempt, label: Data.label + AttemptSuffix, unit_name: Data.unit_name, first_egg_min: FirstEggMin, first_egg_max: FirstEggMax, proj_hatch_min: ProjHatchMin, proj_hatch_max: ProjHatchMax, actual_hatch: ActualHatch, proj_fledge: ProjFledge, male_age: Ages?.male_age ?? null, female_age: Ages?.female_age ?? null, young_count: YoungCount, banded_count: BandedCount });
        }

        setNestProgress(Progress.sort((a, b) => {
          const u = a.unit_name.localeCompare(b.unit_name);
          return u !== 0 ? u : a.label.localeCompare(b.label);
        }));
        setColonyStats(Progress.length > 0 ? { eggs: StatEggs, hatched: StatHatched, fledged: StatFledged } : null);
      }
      loadAll();
    }, [SeasonId, SiteId, Year])
  );

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
  const InitialDate = NestChecks.length > 0 ? NestChecks[0].check_date : `${Year}-04-01`;

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
                    <Text style={styles.ProgressDates}>
                      {[A.male_age && `♂ ${A.male_age}`, A.female_age && `♀ ${A.female_age}`].filter(Boolean).join('  ')}
                    </Text>
                  </View>
                ))}
              </>
            )}

            {/* ── Banding ── */}
            <Button
              mode="text"
              compact
              icon={BandingExpanded ? 'chevron-up' : 'chevron-down'}
              contentStyle={styles.ExpandBtnContent}
              onPress={() => setBandingExpanded(!BandingExpanded)}
              style={styles.ExpandBtn}
            >
              Banding
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
                <BandingHistogram bars={BandingData} today={todayString()} />
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
                      <Text style={styles.ProgressDates}>
                        {[A.male_age && `♂ ${A.male_age}`, A.female_age && `♀ ${A.female_age}`].filter(Boolean).join('  ')}
                      </Text>
                    </View>
                  ))}
                </>
              )}

              {/* ── Banding ── */}
              <Button
                mode="text"
                compact
                icon={BandingExpanded ? 'chevron-up' : 'chevron-down'}
                contentStyle={styles.ExpandBtnContent}
                onPress={() => setBandingExpanded(!BandingExpanded)}
                style={styles.ExpandBtn}
              >
                Banding
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
                  <BandingHistogram bars={BandingData} today={todayString()} />
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
  ColonyStatsRow:  { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 10, marginTop: 4 },
  ColonyStat:      { alignItems: 'center' },
  ColonyStatNum:   { fontSize: 20, fontWeight: '700', color: '#7b1fa2' },
  ColonyStatLabel: { fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 },
});
