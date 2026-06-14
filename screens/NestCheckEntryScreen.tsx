import React, { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, TextInput as RNTextInput, View } from 'react-native';
import {
  Button, Checkbox, Dialog, Divider, HelperText,
  Icon, IconButton, Portal, RadioButton, Text, TextInput,
} from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { AppStackParamList } from '../App';
import { useSettings } from '../contexts/SettingsContext';
import { useSync } from '../contexts/SyncContext';
import {
  getLocalEntriesForCompartment,
  cacheEntries, getLocalEntry,
  getLocalNestlings, cacheNestlings,
  getLocalBands, cacheBands, getLocalPriorBandCounts,
  upsertLocalEntry, upsertLocalNestling, replaceLocalBands,
  upsertLocalNestSeason, deleteLocalEntry, makeId, setLocalEntriesNestingAttempt,
  resetLocalNestingAttemptsForCompartment,
} from '../lib/localDb';

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'NestCheckEntry'>;
  route: RouteProp<AppStackParamList, 'NestCheckEntry'>;
};

type PrevEntry = {
  check_date: string;
  species: string;
  is_empty_cavity: boolean;
  has_nest: boolean;
  egg_count: number;
  discarded_eggs: number;
  young_count: number;
};

type NestlingBand = {
  band_type: 'federal' | 'color';
  band_color: string | null;
  band_code: string;
};

type NestlingRecord = {
  id: string | null;       // null = new this session, not yet in DB
  label: string;
  bandsThisCheck: NestlingBand[];
  totalPriorBands: number;
};

type AdultBand = {
  is_new_banding: boolean;
  bird_type: 'adult_male' | 'adult_female';
  band_type: 'federal' | 'color';
  band_color: string | null;
  band_code: string;
};

const SpeciesList = [
  { label: 'Purple Martin',     value: 'PM' },
  { label: 'House Sparrow',     value: 'HS' },
  { label: 'European Starling', value: 'ST' },
  { label: 'Tree Swallow',      value: 'TS' },
  { label: 'Bluebird',          value: 'BB' },
  { label: 'House Wren',        value: 'HW' },
];

const SpeciesLabel: Record<string, string> = {
  PM: 'Purple Martin', HS: 'House Sparrow', ST: 'Starling',
  TS: 'Tree Swallow',  BB: 'Bluebird',      HW: 'House Wren',
};

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function computeConfirmedAge(others: (string | null)[], current: string | null): string | null {
  const Counts: Record<string, number> = {};
  for (const O of [...others, current]) if (O) Counts[O] = (Counts[O] ?? 0) + 1;
  for (const [Age, N] of Object.entries(Counts)) if (N >= 3) return Age;
  return null;
}

// ── Counter ────────────────────────────────────────────────────────────────
function Counter({
  label, value, onChange, prevValue,
}: {
  label: string; value: number; onChange: (n: number) => void; prevValue?: number | null;
}) {
  return (
    <View style={styles.Counter}>
      {label !== '' && <Text style={styles.CounterLabel}>{label}</Text>}
      <View style={styles.CounterControls}>
        <IconButton icon="minus" size={18} onPress={() => onChange(Math.max(0, value - 1))} style={styles.StepBtn} />
        <RNTextInput
          value={String(value)}
          onChangeText={(T) => { const N = parseInt(T, 10); onChange(isNaN(N) || N < 0 ? 0 : N); }}
          keyboardType="numeric"
          selectTextOnFocus
          style={styles.CounterInput}
        />
        <IconButton icon="plus" size={18} onPress={() => onChange(value + 1)} style={styles.StepBtn} />
      </View>
      {prevValue != null && (
        <Button
          mode="outlined"
          compact
          onPress={() => onChange(prevValue)}
          style={styles.PrevBtn}
          labelStyle={styles.PrevBtnLabel}
        >
          prev: {prevValue}
        </Button>
      )}
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────
export default function NestCheckEntryScreen({ navigation, route }: Props) {
  const { CheckId, CheckDate, SeasonId, SiteId, CompartmentId, ExistingEntryId, AllCompartments, CompartmentIndex } = route.params;
  const NextCompartment = (AllCompartments && CompartmentIndex !== undefined && CompartmentIndex < AllCompartments.length - 1)
    ? AllCompartments[CompartmentIndex + 1]
    : null;
  const { CompactMode, toggleCompactMode } = useSettings();
  const { isOnline, syncNow } = useSync();
  function L(full: string, compact: string) { return CompactMode ? compact : full; }

  // ── Species ──────────────────────────────────────────────────────────
  const [SpeciesVal, setSpeciesVal]           = useState('PM');
  const [SpeciesExpanded, setSpeciesExpanded] = useState(false);

  // ── Status ───────────────────────────────────────────────────────────
  const [IsEmpty, setIsEmpty]           = useState(false);
  const [AdultPresent, setAdultPresent] = useState(false);
  const [HasNestOnly, setHasNestOnly]   = useState(false); // nest w/ no eggs, or non-PM nest present

  // ── PM-only counts ────────────────────────────────────────────────────
  const [EggCount, setEggCount]               = useState(0);
  const [YoungCount, setYoungCount]           = useState(0);
  const [DiscardedEggs, setDiscardedEggs]     = useState(0);
  const [NestlingAgeDays, setNestlingAgeDays] = useState(0);
  const [IsHatchingDay, setIsHatchingDay]     = useState(false);
  const [HasDeadYoung, setHasDeadYoung]       = useState(false);
  const [DeadYoungCount, setDeadYoungCount]   = useState(0);
  const [FledgedCount, setFledgedCount]       = useState(0);
  const [Renesting, setRenesting]             = useState(false);
  const [NestingAttempt, setNestingAttempt]         = useState(1);
  const [RenestingDialogVisible, setRenestingDialogVisible] = useState(false);
  const [RenestingCandidates, setRenestingCandidates]       = useState<{ check_date: string; egg_count: number; discarded_eggs: number; nest_discarded: boolean; species: string }[]>([]);
  const [SelectedSplitDate, setSelectedSplitDate]           = useState<string | null>(null);
  const AllPriorEntriesRef = useRef<{ id: string; check_date: string; egg_count: number; discarded_eggs: number; young_count: number; adult_present: boolean; is_empty_cavity: boolean; has_nest: boolean; nest_discarded: boolean; species: string }[]>([]);

  // ── Nest management ───────────────────────────────────────────────────
  const [NestDiscarded, setNestDiscarded] = useState(false);
  const [NestReplaced, setNestReplaced]   = useState(false);

  // ── Adult bird ages ───────────────────────────────────────────────────
  const [ObservedMaleAge, setObservedMaleAge]     = useState<'SY' | 'ASY' | 'UNK' | null>(null);
  const [ObservedFemaleAge, setObservedFemaleAge] = useState<'SY' | 'ASY' | 'UNK' | null>(null);
  const [OtherMaleObs, setOtherMaleObs]           = useState<(string | null)[]>([]);
  const [OtherFemaleObs, setOtherFemaleObs]       = useState<(string | null)[]>([]);
  const [AdultAgesExpanded, setAdultAgesExpanded] = useState(false);

  // ── Dead adult (expandable) ───────────────────────────────────────────
  const [DeadAdultExpanded, setDeadAdultExpanded] = useState(false);
  const [DeadAdultMale, setDeadAdultMale]         = useState(false);
  const [DeadAdultFemale, setDeadAdultFemale]     = useState(false);

  // ── Banding ───────────────────────────────────────────────────────────
  const [Nestlings, setNestlings]                           = useState<NestlingRecord[]>([]);
  const [AdultBands, setAdultBands]                         = useState<AdultBand[]>([]);
  const [BandingExpanded, setBandingExpanded]               = useState(false);
  const [AddNestlingBandVisible, setAddNestlingBandVisible] = useState(false);
  const [AddNestlingBandIdx, setAddNestlingBandIdx]         = useState<number | null>(null);
  const [AddAdultBandVisible, setAddAdultBandVisible]       = useState(false);
  const [NewBandType, setNewBandType]                       = useState<'federal' | 'color'>('federal');
  const [NewBandColor, setNewBandColor]                     = useState('');
  const [NewBandCode, setNewBandCode]                       = useState('');
  const [NewBandError, setNewBandError]                     = useState('');
  const [NewAdultBirdType, setNewAdultBirdType]             = useState<'adult_male' | 'adult_female'>('adult_male');
  const [NewAdultIsNew, setNewAdultIsNew]                   = useState(true);

  // ── Notes (expandable) ────────────────────────────────────────────────
  const [NotesExpanded, setNotesExpanded] = useState(false);
  const [Notes, setNotes]               = useState('');

  // ── Previous check & hatch date ───────────────────────────────────────
  const [PrevEntry, setPrevEntry] = useState<PrevEntry | null>(null);
  const [CalculatedNestlingAge, setCalculatedNestlingAge] = useState<number | null>(null);
  const [PriorEggsSeen, setPriorEggsSeen]   = useState(false);
  const [PriorYoungSeen, setPriorYoungSeen] = useState(false);
  const [FirstEggRange, setFirstEggRange]             = useState<{min: string; max: string} | null>(null);
  const [ProjectedHatchRange, setProjectedHatchRange] = useState<{min: string; max: string} | null>(null);
  const [ActualHatchDate, setActualHatchDate]         = useState<string | null>(null);
  const [ProjectedFledgeDate, setProjectedFledgeDate] = useState<string | null>(null);

  // ── Loading / saving / deleting ───────────────────────────────────────
  const [InitLoading, setInitLoading]     = useState(!!ExistingEntryId);
  const [Saving, setSaving]               = useState(false);
  const [DeleteVisible, setDeleteVisible] = useState(false);
  const [Deleting, setDeleting]           = useState(false);
  const [ErrorMessage, setErrorMessage]   = useState('');

  // ── Unsaved-changes guard ─────────────────────────────────────────────
  const IsDirty = useRef(false);
  const [IsDirtyState, setIsDirtyState] = useState(false);
  const [AbandonVisible, setAbandonVisible] = useState(false);
  function MarkDirty() {
    if (!IsDirty.current) { IsDirty.current = true; setIsDirtyState(true); }
  }
  function ClearDirty() { IsDirty.current = false; setIsDirtyState(false); }

  // ── Derived ───────────────────────────────────────────────────────────
  const IsPM    = SpeciesVal === 'PM';
  const HasNest = IsPM ? (!IsEmpty && (EggCount > 0 || YoungCount > 0 || HasNestOnly)) : true;

  // Keep a ref to handleSave that's always current, so the header button never closes over a stale version
  const handleSaveRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { handleSaveRef.current = handleSave; });

  // Header right: Save button (when dirty) + compact toggle
  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {IsDirtyState && (
            <Button
              mode="contained"
              compact
              loading={Saving}
              onPress={() => handleSaveRef.current()}
              style={{ marginRight: 4 }}
            >
              Save
            </Button>
          )}
          <IconButton
            icon={CompactMode ? 'view-compact' : 'view-compact-outline'}
            size={22}
            onPress={toggleCompactMode}
            style={{ marginRight: 4 }}
          />
        </View>
      ),
    });
  }, [IsDirtyState, Saving, CompactMode]);

  // When dirty: disable swipe-back and replace the native header back button
  useEffect(() => {
    navigation.setOptions({
      gestureEnabled: !IsDirtyState,
      headerLeft: IsDirtyState
        ? () => <IconButton icon="arrow-left" size={24} onPress={() => setAbandonVisible(true)} />
        : undefined,
    });
  }, [IsDirtyState, navigation]);

  // Fetch season context: prev-entry banner + hatch-date for nestling age
  useEffect(() => {
    async function fetchSeasonContext() {
      const YearStr = CheckDate.substring(0, 4);

      // Flat list of other entries for this compartment in this season, with check_date
      type SeasonEntry = {
        id: string; check_date: string; species: string;
        is_empty_cavity: boolean | number; has_nest: boolean | number;
        nest_discarded: boolean | number; adult_present: boolean | number;
        egg_count: number; discarded_eggs: number; young_count: number; nestling_age_days: number | null;
        observed_male_age: string | null; observed_female_age: string | null;
      };
      let Entries: SeasonEntry[] = [];

      try {
        const { data: SeasonChecks, error: CErr } = await supabase
          .from('nest_checks')
          .select('id, check_date')
          .eq('site_id', SiteId)
          .gte('check_date', `${YearStr}-01-01`)
          .lte('check_date', `${YearStr}-12-31`)
          .neq('id', CheckId)
          .order('check_date', { ascending: true });
        if (CErr) throw CErr;
        if (!SeasonChecks || SeasonChecks.length === 0) return;

        const { data: OtherEntries, error: EErr } = await supabase
          .from('nest_check_entries')
          .select('id, nest_check_id, species, is_empty_cavity, has_nest, nest_discarded, adult_present, egg_count, discarded_eggs, young_count, nestling_age_days, observed_male_age, observed_female_age')
          .in('nest_check_id', SeasonChecks.map(c => c.id))
          .eq('compartment_id', CompartmentId);
        if (EErr) throw EErr;
        if (!OtherEntries) return;

        Entries = OtherEntries.map(E => {
          const C = SeasonChecks.find(c => c.id === E.nest_check_id)!;
          return { ...E, check_date: C.check_date };
        });
        // PostgREST caches the DB schema, so newly-added columns may come back as
        // undefined until the cache refreshes. Read adult_present from local SQLite,
        // which is always correct after save, and merge it in.
        try {
          const LocalEs = await getLocalEntriesForCompartment(CompartmentId, SiteId, parseInt(YearStr, 10), CheckId);
          const AdultMap = new Map(LocalEs.map(e => [e.id, !!e.adult_present]));
          Entries = Entries.map(e => ({
            ...e,
            adult_present: AdultMap.has((e as any).id)
              ? AdultMap.get((e as any).id)!
              : !!(e as any).adult_present,
          }));
        } catch {}
      } catch {
        // Offline or web: use local DB cache
        try {
          Entries = await getLocalEntriesForCompartment(
            CompartmentId, SiteId, parseInt(YearStr, 10), CheckId
          );
        } catch {}
      }

      if (Entries.length === 0) return;

      AllPriorEntriesRef.current = Entries.map(e => ({
        id: (e as any).id ?? '',
        check_date: e.check_date,
        species: e.species,
        egg_count: e.egg_count,
        discarded_eggs: e.discarded_eggs ?? 0,
        young_count: e.young_count ?? 0,
        adult_present: !!(e as any).adult_present,
        is_empty_cavity: !!e.is_empty_cavity,
        has_nest: !!e.has_nest,
        nest_discarded: !!e.nest_discarded,
      }));

      setPriorEggsSeen(Entries.some(e => (e.egg_count ?? 0) > 0));
      setPriorYoungSeen(Entries.some(e => (e.young_count ?? 0) > 0));

      const MaleObs   = Entries.map(e => e.observed_male_age ?? null);
      const FemaleObs = Entries.map(e => e.observed_female_age ?? null);
      setOtherMaleObs(MaleObs);
      setOtherFemaleObs(FemaleObs);
      // Adult ages section stays closed by default

      // Prev entry: most recent checked entry before current date (skip adult_present)
      const Prev = [...Entries]
        .filter(e => e.check_date < CheckDate && !(e as any).adult_present)
        .sort((a, b) => b.check_date.localeCompare(a.check_date))[0];
      if (Prev) {
        setPrevEntry({
          check_date:       Prev.check_date,
          species:          Prev.species,
          is_empty_cavity:  !!Prev.is_empty_cavity,
          has_nest:         !!Prev.has_nest,
          egg_count:        Prev.egg_count,
          discarded_eggs:   Prev.discarded_eggs ?? 0,
          young_count:      Prev.young_count,
        });
      }

      // Exclude adult_present entries from egg/hatch calculations (nest wasn't checked)
      const EWD = [...Entries].filter(e => !(e as any).adult_present).sort((a, b) => a.check_date.localeCompare(b.check_date));

      // First egg date range
      const FirstWithEggs = EWD.find(e => e.egg_count > 0);
      if (FirstWithEggs) {
        const LastEmpty = [...EWD]
          .filter(e => e.egg_count === 0 && e.check_date < FirstWithEggs.check_date)
          .pop();
        const LatestFirst   = addDays(FirstWithEggs.check_date, -(FirstWithEggs.egg_count - 1));
        const EarliestFirst = LastEmpty ? addDays(LastEmpty.check_date, 1) : null;
        const MinFirst = (EarliestFirst && EarliestFirst <= LatestFirst) ? EarliestFirst : LatestFirst;
        setFirstEggRange({ min: MinFirst, max: LatestFirst });

        const MaxEggs = Math.max(...EWD.map(e => e.egg_count));
        setProjectedHatchRange({
          min: addDays(MinFirst,    MaxEggs - 1 + 15),
          max: addDays(LatestFirst, MaxEggs - 1 + 15),
        });
      }

      // Hatch date anchor: earliest check with a recorded nestling age
      for (const E of EWD) {
        if ((E.young_count ?? 0) > 0 && E.nestling_age_days != null) {
          const [ay, am, ad] = E.check_date.split('-').map(Number);
          const Hatch = new Date(ay, am - 1, ad);
          Hatch.setDate(Hatch.getDate() - E.nestling_age_days!);
          const HatchStr = `${Hatch.getFullYear()}-${String(Hatch.getMonth() + 1).padStart(2, '0')}-${String(Hatch.getDate()).padStart(2, '0')}`;
          setActualHatchDate(HatchStr);
          setProjectedFledgeDate(addDays(HatchStr, 26));
          const [cy, cm, cd] = CheckDate.split('-').map(Number);
          const DiffDays = Math.round(
            (new Date(cy, cm - 1, cd).getTime() - Hatch.getTime()) / 86400000
          );
          if (DiffDays > 0) setCalculatedNestlingAge(DiffDays);
          break;
        }
      }
    }
    fetchSeasonContext();
  }, []);

  // Load existing entry
  useEffect(() => {
    if (!ExistingEntryId) return;
    async function loadEntry() {
      let E: any = null;
      try {
        const { data, error } = await supabase
          .from('nest_check_entries').select('*').eq('id', ExistingEntryId!).single();
        if (error) throw error;
        E = data;
        if (E) cacheEntries([E]).catch(() => {});
      } catch {
        try { E = await getLocalEntry(ExistingEntryId!); } catch {}
      }
      if (!E) return;
      setSpeciesVal(E.species ?? 'PM');
      setIsEmpty(!!E.is_empty_cavity);
      setAdultPresent(!!(E as any).adult_present);
      setEggCount(E.egg_count ?? 0);
      setYoungCount(E.young_count ?? 0);
      setHasNestOnly(!!E.has_nest && E.egg_count === 0 && E.young_count === 0);
      setDiscardedEggs(E.discarded_eggs ?? 0);
      setIsHatchingDay(E.nestling_age_days === 0);
      setNestlingAgeDays(E.nestling_age_days ?? 0);
      setHasDeadYoung((E.dead_young_count ?? 0) > 0);
      setDeadYoungCount(E.dead_young_count ?? 0);
      setFledgedCount(E.fledged_count ?? 0);
      setRenesting(!!E.renesting_attempt);
      setNestingAttempt(E.nesting_attempt ?? 1);
      setNestDiscarded(!!E.nest_discarded);
      setNestReplaced(!!E.nest_replaced);
      setDeadAdultMale(!!E.dead_adult_male);
      setDeadAdultFemale(!!E.dead_adult_female);
      if (E.dead_adult_male || E.dead_adult_female) setDeadAdultExpanded(true);
      setNotes(E.notes ?? '');
      if (E.notes) setNotesExpanded(true);
      const OM = (E.observed_male_age as 'SY' | 'ASY' | 'UNK' | null) ?? null;
      const OF = (E.observed_female_age as 'SY' | 'ASY' | 'UNK' | null) ?? null;
      setObservedMaleAge(OM); setObservedFemaleAge(OF);
      setInitLoading(false);
    }
    loadEntry();
  }, [ExistingEntryId]);

  // Load nestlings for this compartment+season, plus any bands for this entry
  useEffect(() => {
    async function loadBandingContext() {
      let NestlingRows: { id: string; label: string }[] = [];
      let BandRows: any[] = [];
      let priorCounts = new Map<string, number>();

      try {
        const [{ data: SNestlings, error: NErr }, { data: SBands, error: BErr }] = await Promise.all([
          supabase.from('nestlings').select('id, label')
            .eq('compartment_id', CompartmentId).eq('site_season_id', SeasonId)
            .order('created_at'),
          ExistingEntryId
            ? supabase.from('bands')
                .select('nestling_id, is_new_banding, bird_type, band_type, band_color, band_code')
                .eq('nest_check_entry_id', ExistingEntryId)
            : Promise.resolve({ data: [] as any[], error: null }),
        ]);
        if (NErr) throw NErr;
        if (BErr) throw BErr;

        NestlingRows = SNestlings ?? [];
        BandRows = SBands ?? [];

        cacheNestlings(NestlingRows.map(N => ({
          id: N.id, compartment_id: CompartmentId, site_season_id: SeasonId, label: N.label,
        }))).catch(() => {});
        if (ExistingEntryId && BandRows.length > 0) {
          cacheBands(BandRows.map((B: any) => ({ ...B, nest_check_entry_id: ExistingEntryId }))).catch(() => {});
        }

        const nestlingIds = NestlingRows.map(n => n.id);
        if (nestlingIds.length > 0) {
          let q = supabase.from('bands').select('nestling_id').in('nestling_id', nestlingIds);
          if (ExistingEntryId) q = (q as any).neq('nest_check_entry_id', ExistingEntryId);
          const { data: PriorBands } = await q;
          if (PriorBands) for (const B of PriorBands as any[]) {
            if (B.nestling_id) priorCounts.set(B.nestling_id, (priorCounts.get(B.nestling_id) ?? 0) + 1);
          }
        }
      } catch {
        try {
          NestlingRows = await getLocalNestlings(CompartmentId, SeasonId);
          BandRows = ExistingEntryId ? await getLocalBands(ExistingEntryId) : [];
          priorCounts = await getLocalPriorBandCounts(
            NestlingRows.map(n => n.id), ExistingEntryId ?? null
          );
        } catch {}
      }

      const records: NestlingRecord[] = NestlingRows.map(N => ({
        id:             N.id,
        label:          N.label,
        bandsThisCheck: BandRows
          .filter((B: any) => B.nestling_id === N.id)
          .map((B: any) => ({ band_type: B.band_type, band_color: B.band_color ?? null, band_code: B.band_code })),
        totalPriorBands: priorCounts.get(N.id) ?? 0,
      }));

      const adultBands: AdultBand[] = BandRows
        .filter((B: any) => !B.nestling_id)
        .map((B: any) => ({
          is_new_banding: !!B.is_new_banding,
          bird_type:      B.bird_type as AdultBand['bird_type'],
          band_type:      B.band_type as AdultBand['band_type'],
          band_color:     B.band_color ?? null,
          band_code:      B.band_code,
        }));

      setNestlings(records);
      setAdultBands(adultBands);
      // Banding section stays closed by default
    }
    loadBandingContext();
  }, [CompartmentId, SeasonId, ExistingEntryId]);

  // ── Banding helpers ────────────────────────────────────────────────────
  function openAddNestlingBand(Idx: number) {
    setAddNestlingBandIdx(Idx);
    setNewBandType('federal');
    setNewBandColor('');
    setNewBandCode('');
    setNewBandError('');
    setAddNestlingBandVisible(true);
  }

  function handleCancelNestlingBand() {
    if (AddNestlingBandIdx !== null) {
      const N = Nestlings[AddNestlingBandIdx];
      if (N && N.id === null && N.bandsThisCheck.length === 0) {
        setNestlings(Ns => Ns.filter((_, I) => I !== AddNestlingBandIdx));
      }
    }
    setAddNestlingBandVisible(false);
  }

  function handleConfirmNestlingBand() {
    if (!NewBandCode.trim()) { setNewBandError('Please enter a band number or code.'); return; }
    MarkDirty();
    if (AddNestlingBandIdx === null) return;
    const Band: NestlingBand = {
      band_type:  NewBandType,
      band_color: NewBandType === 'color' ? (NewBandColor.trim() || null) : null,
      band_code:  NewBandCode.trim().toUpperCase(),
    };
    setNestlings(Ns => Ns.map((N, I) =>
      I === AddNestlingBandIdx ? { ...N, bandsThisCheck: [...N.bandsThisCheck, Band] } : N
    ));
    setAddNestlingBandVisible(false);
  }

  function handleConfirmAdultBand() {
    if (!NewBandCode.trim()) { setNewBandError('Please enter a band number or code.'); return; }
    MarkDirty();
    setAdultBands(Ab => [...Ab, {
      is_new_banding: NewAdultIsNew,
      bird_type:      NewAdultBirdType,
      band_type:      NewBandType,
      band_color:     NewBandType === 'color' ? (NewBandColor.trim() || null) : null,
      band_code:      NewBandCode.trim().toUpperCase(),
    }]);
    setAddAdultBandVisible(false);
  }

  function handleSpeciesChange(Val: string) {
    MarkDirty();
    setSpeciesVal(Val);
    setSpeciesExpanded(false);
    if (Val !== 'PM') {
      setEggCount(0); setYoungCount(0); setDiscardedEggs(0);
      setNestlingAgeDays(0); setIsHatchingDay(false); setHasDeadYoung(false); setDeadYoungCount(0);
      setFledgedCount(0); setRenesting(false);
      setNestReplaced(false);
      setIsEmpty(false); setAdultPresent(false); setHasNestOnly(false);
    }
    if (Val !== 'HS' && Val !== 'ST') {
      setNestDiscarded(false);
    }
  }

  // ── Save (local-first; syncs to Supabase in background) ───────────────
  async function performSave(): Promise<boolean> {
    setSaving(true);
    setErrorMessage('');

    if (!ExistingEntryId && IsPM) {
      if (YoungCount > 0 && EggCount === 0 && !PriorEggsSeen) {
        setErrorMessage('Eggs must be recorded before young can appear. Record a check showing eggs first.');
        setSaving(false);
        return false;
      }
      if (FledgedCount > 0 && YoungCount === 0 && !PriorYoungSeen) {
        setErrorMessage('Young must be present before fledging can occur. No young have been recorded for this compartment yet.');
        setSaving(false);
        return false;
      }
    }

    const EntryPayload = {
      nest_check_id:      CheckId,
      compartment_id:     CompartmentId,
      species:            SpeciesVal,
      is_empty_cavity:    IsEmpty,
      has_nest:           HasNest,
      adult_present:      IsPM && !IsEmpty ? AdultPresent : false,
      nest_discarded:     HasNest && (SpeciesVal === 'HS' || SpeciesVal === 'ST') ? NestDiscarded : false,
      nest_replaced:      HasNest && IsPM ? NestReplaced : false,
      egg_count:          IsPM && !IsEmpty && !AdultPresent ? EggCount : 0,
      discarded_eggs:     IsPM && EggCount > 0 && !AdultPresent ? DiscardedEggs : 0,
      young_count:        IsPM && !IsEmpty && !AdultPresent ? YoungCount : 0,
      nestling_age_days:  IsPM && YoungCount > 0
        ? (CalculatedNestlingAge ?? (IsHatchingDay ? 0 : (NestlingAgeDays > 0 ? NestlingAgeDays : null)))
        : null,
      nestling_age_notes: null as null,
      dead_young_count:   IsPM && YoungCount > 0 && HasDeadYoung ? DeadYoungCount : 0,
      dead_adult_male:    DeadAdultMale,
      dead_adult_female:  DeadAdultFemale,
      fledged_count:      IsPM && HasNest ? FledgedCount : 0,
      renesting_attempt:  IsPM && HasNest ? Renesting : false,
      nesting_attempt:      NestingAttempt,
      notes:              Notes.trim() || null,
      observed_male_age:  IsPM ? ObservedMaleAge : null,
      observed_female_age: IsPM ? ObservedFemaleAge : null,
    };

    const EntryId = ExistingEntryId ?? makeId();

    // Try local-first (native offline support)
    let savedLocally = false;
    try {
      await upsertLocalEntry({ id: EntryId, ...EntryPayload });

      const NewLabelToId = new Map<string, string>();
      for (const N of Nestlings.filter(n => n.id === null && n.bandsThisCheck.length > 0)) {
        const NewId = makeId();
        await upsertLocalNestling({
          id: NewId, compartment_id: CompartmentId, site_season_id: SeasonId, label: N.label,
        });
        NewLabelToId.set(N.label, NewId);
      }

      const LocalBandRows: {
        id: string; nestling_id: string | null; is_new_banding: boolean;
        bird_type: string; band_type: string; band_color: string | null; band_code: string;
      }[] = [];
      for (const N of Nestlings) {
        if (N.bandsThisCheck.length === 0) continue;
        const NestlingId = N.id ?? NewLabelToId.get(N.label) ?? null;
        for (const B of N.bandsThisCheck) {
          LocalBandRows.push({
            id: makeId(), nestling_id: NestlingId, is_new_banding: true,
            bird_type: 'nestling', band_type: B.band_type, band_color: B.band_color, band_code: B.band_code,
          });
        }
      }
      for (const B of AdultBands) {
        LocalBandRows.push({
          id: makeId(), nestling_id: null, is_new_banding: B.is_new_banding,
          bird_type: B.bird_type, band_type: B.band_type, band_color: B.band_color, band_code: B.band_code,
        });
      }
      await replaceLocalBands(EntryId, LocalBandRows);

      if (IsPM) {
        const ConfirmedMale   = computeConfirmedAge(OtherMaleObs,   ObservedMaleAge);
        const ConfirmedFemale = computeConfirmedAge(OtherFemaleObs, ObservedFemaleAge);
        await upsertLocalNestSeason({
          compartment_id: CompartmentId, site_season_id: SeasonId,
          year: parseInt(CheckDate.substring(0, 4), 10),
          male_age: ConfirmedMale, female_age: ConfirmedFemale,
        });
      }

      syncNow();
      savedLocally = true;
    } catch {}

    if (!savedLocally) {
      // Web (no SQLite): write directly to Supabase
      let SaveErr;
      if (ExistingEntryId) {
        ({ error: SaveErr } = await supabase.from('nest_check_entries').update(EntryPayload).eq('id', ExistingEntryId));
      } else {
        ({ error: SaveErr } = await supabase.from('nest_check_entries').insert({ id: EntryId, ...EntryPayload }));
      }
      if (SaveErr) { setErrorMessage(SaveErr.message); setSaving(false); return false; }

      // Nestlings
      const NewLabelToId = new Map<string, string>();
      const NestlingsToCreate = Nestlings.filter(N => N.id === null && N.bandsThisCheck.length > 0);
      if (NestlingsToCreate.length > 0) {
        const { data: Created, error: NestlingErr } = await supabase
          .from('nestlings')
          .insert(NestlingsToCreate.map(N => ({ compartment_id: CompartmentId, site_season_id: SeasonId, label: N.label })))
          .select('id, label');
        if (NestlingErr) { setErrorMessage(`Nestlings: ${NestlingErr.message}`); setSaving(false); return false; }
        if (Created) for (const N of Created) NewLabelToId.set(N.label, N.id);
      }

      // Bands
      await supabase.from('bands').delete().eq('nest_check_entry_id', EntryId);
      const SupaBandRows: object[] = [];
      for (const N of Nestlings) {
        if (N.bandsThisCheck.length === 0) continue;
        const NestlingId = N.id ?? NewLabelToId.get(N.label) ?? null;
        for (const B of N.bandsThisCheck) {
          SupaBandRows.push({ nest_check_entry_id: EntryId, nestling_id: NestlingId, is_new_banding: true, bird_type: 'nestling', band_type: B.band_type, band_color: B.band_color, band_code: B.band_code });
        }
      }
      for (const B of AdultBands) {
        SupaBandRows.push({ nest_check_entry_id: EntryId, nestling_id: null, is_new_banding: B.is_new_banding, bird_type: B.bird_type, band_type: B.band_type, band_color: B.band_color, band_code: B.band_code });
      }
      if (SupaBandRows.length > 0) {
        const { error: BandErr } = await supabase.from('bands').insert(SupaBandRows);
        if (BandErr) { setErrorMessage(`Bands: ${BandErr.message}`); setSaving(false); return false; }
      }

      // Nest seasons
      if (IsPM) {
        const ConfirmedMale   = computeConfirmedAge(OtherMaleObs,   ObservedMaleAge);
        const ConfirmedFemale = computeConfirmedAge(OtherFemaleObs, ObservedFemaleAge);
        const { data: Existing } = await supabase.from('nest_seasons').select('id').eq('compartment_id', CompartmentId).eq('site_season_id', SeasonId).maybeSingle();
        if (Existing) {
          await supabase.from('nest_seasons').update({ male_age: ConfirmedMale, female_age: ConfirmedFemale }).eq('id', Existing.id);
        } else {
          await supabase.from('nest_seasons').insert({ compartment_id: CompartmentId, site_season_id: SeasonId, year: parseInt(CheckDate.substring(0, 4), 10), male_age: ConfirmedMale, female_age: ConfirmedFemale });
        }
      }
    }

    setSaving(false);
    ClearDirty();
    return true;
  }

  async function tagFutureEntriesAsAttempt2() {
    const FutureIds = AllPriorEntriesRef.current
      .filter(e => e.check_date > CheckDate)
      .map(e => e.id).filter(id => id !== '');
    if (FutureIds.length > 0) {
      try { await supabase.from('nest_check_entries').update({ nesting_attempt: 2 }).in('id', FutureIds); } catch {}
      try { await setLocalEntriesNestingAttempt(FutureIds, 2); } catch {}
    }
  }

  async function handleRenestingToggle() {
    MarkDirty();
    if (Renesting) {
      setRenesting(false);
      setNestingAttempt(1);
      // Reset every entry for this compartment/season directly — more reliable than
      // using AllPriorEntriesRef, which only reflects the current session's load
      const YearStr = CheckDate.substring(0, 4);
      try {
        const { data: SeasonChecks } = await supabase
          .from('nest_checks').select('id')
          .eq('site_id', SiteId)
          .gte('check_date', `${YearStr}-01-01`)
          .lte('check_date', `${YearStr}-12-31`);
        if (SeasonChecks && SeasonChecks.length > 0) {
          await supabase.from('nest_check_entries')
            .update({ nesting_attempt: 1 })
            .in('nest_check_id', SeasonChecks.map(c => c.id))
            .eq('compartment_id', CompartmentId);
        }
      } catch {}
      try { await resetLocalNestingAttemptsForCompartment(CompartmentId, SiteId, parseInt(YearStr, 10)); } catch {}
      return;
    }
    const Prior = [...AllPriorEntriesRef.current]
      .filter(e => e.check_date < CheckDate)
      .sort((a, b) => a.check_date.localeCompare(b.check_date));
    setRenesting(true);
    if (Prior.length === 0) { await tagFutureEntriesAsAttempt2(); setNestingAttempt(2); return; }

    // Use net eggs (deducting discards) so a check where all eggs were discarded
    // is correctly treated as a true trough, not as eggs still present
    const NetEggs = (e: typeof Prior[0]) => Math.max(0, e.egg_count - e.discarded_eggs);

    // Find peak: last occurrence of the maximum net egg count
    const MaxNetEggs = Math.max(...Prior.map(NetEggs));
    let PeakIdx = -1;
    for (let i = Prior.length - 1; i >= 0; i--) {
      if (NetEggs(Prior[i]) === MaxNetEggs) { PeakIdx = i; break; }
    }
    const DeclineZone = Prior.slice(PeakIdx + 1);
    if (DeclineZone.length === 0) {
      await tagFutureEntriesAsAttempt2();
      setNestingAttempt(2);
      Alert.alert(
        'Renesting Attempt',
        'This check marks the start of Attempt 2. Subsequent checks for this compartment have been updated. Save this record to complete the change.',
        [{ text: 'OK' }],
      );
      return;
    }

    // An entry counts as "nest not inspected" if adult_present is set, OR if it has
    // the data signature of an unchecked entry (has_nest=false, no eggs, no discards,
    // not an empty cavity) — guards against stale PostgREST schema cache returning
    // adult_present as undefined.
    const IsUnchecked = (e: typeof Prior[0]) =>
      e.adult_present ||
      (!e.is_empty_cavity && !e.has_nest &&
       e.egg_count === 0 && e.discarded_eggs === 0 && e.young_count === 0 && !e.nest_discarded);

    // Exclude checks where eggs declined due to hatching, or nest wasn't inspected
    const ValidDecline = DeclineZone.filter(e => e.young_count === 0 && !IsUnchecked(e));
    if (ValidDecline.length === 0) {
      await tagFutureEntriesAsAttempt2();
      setNestingAttempt(2);
      const WasUnchecked = DeclineZone.some(e => IsUnchecked(e) && e.young_count === 0);
      Alert.alert(
        'Renesting Attempt',
        WasUnchecked
          ? 'The nest was not inspected at the prior check(s), so the exact end of the first clutch is unknown. This check marks the start of Attempt 2. Subsequent checks for this compartment have been updated. Save this record to complete the change.'
          : 'The prior clutch appears to have hatched successfully. This check marks the start of Attempt 2. Subsequent checks for this compartment have been updated. Save this record to complete the change.',
        [{ text: 'OK' }],
      );
      return;
    }

    // Find trough in the decline zone using net eggs
    const TroughNetEggs = Math.min(...ValidDecline.map(NetEggs));
    // Most-recent first so the default selection is the latest trough
    const Candidates = [...ValidDecline]
      .filter(e => NetEggs(e) === TroughNetEggs)
      .reverse()
      .map(e => ({
        check_date: e.check_date,
        egg_count: e.egg_count,
        discarded_eggs: e.discarded_eggs,
        nest_discarded: e.nest_discarded,
        species: e.species,
      }));

    setRenestingCandidates(Candidates);
    setSelectedSplitDate(Candidates[0].check_date);
    setRenestingDialogVisible(true);
  }

  async function handleRenestingConfirm() {
    if (!SelectedSplitDate) { setNestingAttempt(2); setRenestingDialogVisible(false); return; }
    const SelCandidate = RenestingCandidates.find(c => c.check_date === SelectedSplitDate);
    const TroughNet = SelCandidate ? Math.max(0, SelCandidate.egg_count - SelCandidate.discarded_eggs) : 0;
    // If the trough was truly empty (all eggs discarded), it belongs to attempt 1.
    // Only entries strictly AFTER the trough date start attempt 2.
    // If the trough had remaining eggs, those may be new RA eggs, so include it in attempt 2.
    const PriorIds = AllPriorEntriesRef.current
      .filter(e => (TroughNet === 0
        ? e.check_date > SelectedSplitDate
        : e.check_date >= SelectedSplitDate) && e.check_date < CheckDate)
      .map(e => e.id)
      .filter(id => id !== '');
    const FutureIds = AllPriorEntriesRef.current
      .filter(e => e.check_date > CheckDate)
      .map(e => e.id).filter(id => id !== '');
    const AllIds = [...PriorIds, ...FutureIds];
    if (AllIds.length > 0) {
      try { await supabase.from('nest_check_entries').update({ nesting_attempt: 2 }).in('id', AllIds); } catch {}
      try { await setLocalEntriesNestingAttempt(AllIds, 2); } catch {}
    }
    setNestingAttempt(2);
    setRenestingDialogVisible(false);
  }

  function handleRenestingCancel() {
    setRenesting(false);
    setNestingAttempt(1);
    setRenestingCandidates([]);
    setSelectedSplitDate(null);
    setRenestingDialogVisible(false);
  }

  async function handleSave() {
    if (await performSave()) navigation.goBack();
  }

  async function handleSaveAndNext() {
    if (!await performSave()) return;
    if (NextCompartment) {
      navigation.replace('NestCheckEntry', {
        CheckId, CheckDate, SeasonId, SiteId,
        CompartmentId:    NextCompartment.id,
        CompartmentLabel: NextCompartment.cavity_label,
        UnitName:         NextCompartment.unit_name,
        ExistingEntryId:  NextCompartment.entry_id,
        AllCompartments,
        CompartmentIndex: CompartmentIndex! + 1,
      });
    } else {
      navigation.goBack();
    }
  }

  // ── Delete entry ───────────────────────────────────────────────────────
  async function handleDelete() {
    if (!ExistingEntryId) return;
    if (!isOnline) {
      setErrorMessage('Cannot delete while offline. Reconnect and try again.');
      setDeleteVisible(false);
      return;
    }
    setDeleting(true);
    // If this entry carried the renesting flag, unwind all other entries in the
    // season for this compartment back to attempt 1 (same as unchecking the checkbox)
    if (Renesting) {
      const YearStr = CheckDate.substring(0, 4);
      try {
        const { data: SeasonChecks } = await supabase
          .from('nest_checks').select('id')
          .eq('site_id', SiteId)
          .gte('check_date', `${YearStr}-01-01`)
          .lte('check_date', `${YearStr}-12-31`);
        if (SeasonChecks && SeasonChecks.length > 0) {
          await supabase.from('nest_check_entries')
            .update({ nesting_attempt: 1 })
            .in('nest_check_id', SeasonChecks.map(c => c.id))
            .eq('compartment_id', CompartmentId);
        }
      } catch {}
      try { await resetLocalNestingAttemptsForCompartment(CompartmentId, SiteId, parseInt(YearStr, 10)); } catch {}
    }
    await deleteLocalEntry(ExistingEntryId);
    const { error } = await supabase.from('nest_check_entries').delete().eq('id', ExistingEntryId);
    setDeleting(false);
    if (error) { setErrorMessage(error.message); return; }
    setDeleteVisible(false);
    ClearDirty();
    navigation.goBack();
  }

  if (InitLoading) {
    return <View style={styles.Loading}><Text variant="bodyMedium">Loading entry…</Text></View>;
  }

  const PrevSummary = PrevEntry
    ? PrevEntry.is_empty_cavity ? 'Empty cavity'
      : !PrevEntry.has_nest ? 'No nest'
      : PrevEntry.species === 'PM'
        ? `PM · ${PrevEntry.egg_count}E${PrevEntry.discarded_eggs > 0 ? '/D' : ''} · ${PrevEntry.young_count}Y`
        : `${SpeciesLabel[PrevEntry.species] ?? PrevEntry.species} nest`
    : null;

  const DeadAdultLabel = [DeadAdultMale && 'M', DeadAdultFemale && 'F'].filter(Boolean).join(' + ');

  return (
    <>
      <ScrollView contentContainerStyle={styles.Container}>

        {/* ── Previous check ──────────────────────────────────────── */}
        {PrevSummary && (
          <Text style={styles.PrevBanner}>
            Last check ({formatDate(PrevEntry!.check_date)}): {PrevSummary}
            {PrevEntry!.young_count > 0 && CalculatedNestlingAge !== null
              ? `. Now ${CalculatedNestlingAge} days old.`
              : ''}
          </Text>
        )}

        {/* ── Egg / hatch / fledge date projections ───────────────── */}
        {(FirstEggRange || ActualHatchDate || ProjectedFledgeDate) && (
          <View style={styles.DateStats}>
            {FirstEggRange && (
              <Text style={styles.DateStat}>
                First egg:{' '}
                {FirstEggRange.min === FirstEggRange.max
                  ? formatDate(FirstEggRange.min)
                  : `${formatDate(FirstEggRange.min)}–${formatDate(FirstEggRange.max)}`}
              </Text>
            )}
            {ProjectedHatchRange && !ActualHatchDate && (
              <Text style={styles.DateStat}>
                Proj. hatch:{' '}
                {ProjectedHatchRange.min === ProjectedHatchRange.max
                  ? formatDate(ProjectedHatchRange.min)
                  : `${formatDate(ProjectedHatchRange.min)}–${formatDate(ProjectedHatchRange.max)}`}
              </Text>
            )}
            {ActualHatchDate && (
              <Text style={styles.DateStat}>Actual Hatch: {formatDate(ActualHatchDate)}</Text>
            )}
            {ProjectedFledgeDate && (
              <Text style={styles.DateStat}>Proj. fledge: {formatDate(ProjectedFledgeDate)}</Text>
            )}
          </View>
        )}

        {/* ── Species ─────────────────────────────────────────────── */}
        <View style={styles.SpeciesRow}>
          <Text variant="bodyMedium" style={styles.SpeciesCurrent}>
            {SpeciesLabel[SpeciesVal] ?? SpeciesVal}
          </Text>
          <Button
            mode="text" compact
            icon={SpeciesExpanded ? 'chevron-up' : 'chevron-down'}
            contentStyle={styles.SpeciesBtnContent}
            onPress={() => setSpeciesExpanded(!SpeciesExpanded)}
          >
            Change
          </Button>
        </View>
        {SpeciesExpanded && (
          <RadioButton.Group onValueChange={handleSpeciesChange} value={SpeciesVal}>
            {SpeciesList.map((S) => (
              <RadioButton.Item key={S.value} label={S.label} value={S.value} />
            ))}
          </RadioButton.Group>
        )}

        <Divider style={styles.Divider} />

        {/* ── Empty cavity (PM only) ───────────────────────────────── */}
        {IsPM && (
          <>
            <Checkbox.Item
              label={L('Empty cavity', 'X')}
              status={IsEmpty ? 'checked' : 'unchecked'}
              onPress={() => {
                MarkDirty();
                const Next = !IsEmpty;
                setIsEmpty(Next);
                if (Next) { setEggCount(0); setYoungCount(0); setHasNestOnly(false); setAdultPresent(false); }
              }}
              style={styles.CheckboxItem}
            />
            <Checkbox.Item
              label={L('Adult present. Nest not checked.', 'A')}
              status={AdultPresent ? 'checked' : 'unchecked'}
              onPress={() => {
                MarkDirty();
                const Next = !AdultPresent;
                setAdultPresent(Next);
                if (Next) { setIsEmpty(false); setHasNestOnly(false); }
              }}
              style={styles.CheckboxItem}
            />
          </>
        )}

        {/* ── Purple Martin form ───────────────────────────────────── */}
        {!IsEmpty && !AdultPresent && IsPM && (
          <>
            {EggCount === 0 && YoungCount === 0 && (
              <Checkbox.Item
                label={L('Nest (no eggs)', 'N')}
                status={HasNestOnly ? 'checked' : 'unchecked'}
                onPress={() => { MarkDirty(); const N = !HasNestOnly; setHasNestOnly(N); if (N) setIsEmpty(false); }}
                style={styles.CheckboxItem}
              />
            )}

            <View style={styles.CountersRow}>
              <Counter
                label={L('Eggs (incl. discards)', 'E')} value={EggCount}
                onChange={(N) => { MarkDirty(); setEggCount(N); if (N > 0) setIsEmpty(false); }}
                prevValue={PrevEntry ? Math.max(0, PrevEntry.egg_count - PrevEntry.discarded_eggs) : undefined}
              />
              <Counter
                label={L('Young', 'Y')} value={YoungCount}
                onChange={(N) => { MarkDirty(); setYoungCount(N); if (N > 0) setIsEmpty(false); }}
                prevValue={PrevEntry?.young_count}
              />
            </View>

            {EggCount > 0 && (
              <Counter label={L('Discarded eggs', 'ED')} value={DiscardedEggs} onChange={(N) => { MarkDirty(); setDiscardedEggs(N); }} />
            )}

            {YoungCount > 0 && (
              <>
                {CalculatedNestlingAge !== null ? (
                  <Text style={styles.CalcAge}>{L('Nestling age', 'Age')}: {CalculatedNestlingAge} days</Text>
                ) : (
                  <>
                    <Checkbox.Item
                      label={L('Hatching Day (HD)', 'HD')}
                      status={IsHatchingDay ? 'checked' : 'unchecked'}
                      onPress={() => { MarkDirty(); setIsHatchingDay(!IsHatchingDay); }}
                      style={styles.CheckboxItem}
                    />
                    {!IsHatchingDay && (
                      <Counter label={L('Nestling age (days)', 'Age')} value={NestlingAgeDays} onChange={(N) => { MarkDirty(); setNestlingAgeDays(N); }} />
                    )}
                  </>
                )}
                <View style={styles.DeadYoungRow}>
                  <Checkbox.Item
                    label={L('Dead young', 'DY')}
                    status={HasDeadYoung ? 'checked' : 'unchecked'}
                    onPress={() => { MarkDirty(); setHasDeadYoung(!HasDeadYoung); }}
                    style={styles.CheckboxItem}
                  />
                  {HasDeadYoung && (
                    <Counter label="" value={DeadYoungCount} onChange={(N) => { MarkDirty(); setDeadYoungCount(N); }} />
                  )}
                </View>
              </>
            )}

            {HasNest && (
              <>
                <Divider style={styles.Divider} />
                <Counter label={L('Fledged', 'F')} value={FledgedCount} onChange={(N) => { MarkDirty(); setFledgedCount(N); }} />
                <Checkbox.Item
                  label={L('Renesting attempt', 'RA')}
                  status={Renesting ? 'checked' : 'unchecked'}
                  onPress={handleRenestingToggle}
                  style={styles.CheckboxItem}
                />
              </>
            )}
          </>
        )}


        {/* ── Nest management (shared) ─────────────────────────────── */}
        {HasNest && (
          <>
            {(SpeciesVal === 'HS' || SpeciesVal === 'ST') && (
              <Checkbox.Item
                label={L('Nest discarded', 'ND')}
                status={NestDiscarded ? 'checked' : 'unchecked'}
                onPress={() => { MarkDirty(); setNestDiscarded(!NestDiscarded); }}
                style={styles.CheckboxItem}
              />
            )}
            {IsPM && (
              <Checkbox.Item
                label={L('Nest replaced', 'NR')}
                status={NestReplaced ? 'checked' : 'unchecked'}
                onPress={() => { MarkDirty(); setNestReplaced(!NestReplaced); }}
                style={styles.CheckboxItem}
              />
            )}
          </>
        )}

        <Divider style={styles.Divider} />

        {/* ── Adult bird ages (expandable, PM only) ───────────────── */}
        {IsPM && (() => {
          const ConfirmedMale   = computeConfirmedAge(OtherMaleObs,   ObservedMaleAge);
          const ConfirmedFemale = computeConfirmedAge(OtherFemaleObs, ObservedFemaleAge);
          const AgeLabel = [ConfirmedMale && `♂ ${ConfirmedMale}`, ConfirmedFemale && `♀ ${ConfirmedFemale}`].filter(Boolean).join('  ');
          const MaleCount   = [...OtherMaleObs,   ObservedMaleAge].filter(Boolean).length;
          const FemaleCount = [...OtherFemaleObs, ObservedFemaleAge].filter(Boolean).length;
          const AgeStatus = (MaleCount >= 3 && FemaleCount >= 3) ? 'complete'
            : (MaleCount > 0 || FemaleCount > 0) ? 'partial'
            : 'none';
          return (
            <>
              <View style={styles.ExpandRow}>
                <Icon
                  source={AgeStatus === 'complete' ? 'check-circle' : 'help-circle-outline'}
                  size={16}
                  color={AgeStatus === 'complete' ? '#22c55e' : AgeStatus === 'partial' ? '#f59e0b' : '#9e9e9e'}
                />
                <Button
                  mode="text" compact
                  icon={AdultAgesExpanded ? 'chevron-up' : 'chevron-down'}
                  contentStyle={styles.ExpandBtnContent}
                  onPress={() => setAdultAgesExpanded(!AdultAgesExpanded)}
                  style={styles.ExpandBtnInRow}
                >
                  {L('Adult ages', 'Ages')}{AgeLabel ? ` · ${AgeLabel}` : ''}
                </Button>
              </View>
              {AdultAgesExpanded && (
                <View style={styles.ExpandedSection}>
                  {([
                    ['Male',   ObservedMaleAge,   setObservedMaleAge,   OtherMaleObs],
                    ['Female', ObservedFemaleAge,  setObservedFemaleAge, OtherFemaleObs],
                  ] as [string, 'SY'|'ASY'|'UNK'|null, (v:'SY'|'ASY'|'UNK'|null)=>void, (string|null)[]][])
                  .map(([Sex, Val, Set, Others]) => {
                    const Confirmed = computeConfirmedAge(Others, Val);
                    const Count = [...Others, Val].filter(Boolean).length;
                    return (
                      <View key={Sex} style={styles.AgeRow}>
                        <Text style={styles.AgeSexLabel}>{Sex}</Text>
                        <View>
                          <View style={styles.AgeChips}>
                            {(['SY', 'ASY', 'UNK'] as const).map(Age => (
                              <Button
                                key={Age} compact
                                mode={Val === Age ? 'contained' : 'outlined'}
                                onPress={() => { MarkDirty(); Set(Val === Age ? null : Age); }}
                                style={styles.AgeChip}
                                labelStyle={styles.AgeChipLabel}
                              >
                                {Age}
                              </Button>
                            ))}
                          </View>
                          {Confirmed
                            ? <Text style={styles.AgeConfirmed}>Confirmed ✓</Text>
                            : Count > 0
                            ? <Text style={styles.AgeCount}>{Count}/3 observations</Text>
                            : null}
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </>
          );
        })()}

        {/* ── Banding (expandable) ────────────────────────────────── */}
        {(() => {
          const HasBands = Nestlings.some(N => N.bandsThisCheck.length > 0) || AdultBands.length > 0;
          const BandedCount = Nestlings.filter(N => N.totalPriorBands > 0 || N.bandsThisCheck.length > 0).length;
          const BandingStatus = Nestlings.length === 0 ? 'none'
            : BandedCount === Nestlings.length ? 'all'
            : BandedCount > 0 ? 'some'
            : 'none';
          return (
            <>
              <View style={styles.ExpandRow}>
                {BandingStatus !== 'none'
                  ? <Icon source="check-circle" size={16} color={BandingStatus === 'all' ? '#22c55e' : '#f59e0b'} />
                  : <View style={styles.ExpandIconSpacer} />
                }
                <Button
                  mode="text" compact
                  icon={BandingExpanded ? 'chevron-up' : 'chevron-down'}
                  contentStyle={styles.ExpandBtnContent}
                  onPress={() => setBandingExpanded(!BandingExpanded)}
                  style={styles.ExpandBtnInRow}
                >
                  {L('Banding (B)', 'B')}{HasBands ? ' · B' : ''}
                </Button>
              </View>
              {BandingExpanded && (
                <View style={styles.ExpandedSection}>

                  {/* Nestlings */}
                  <Text style={styles.BandSubheader}>Nestlings</Text>
                  {Nestlings.map((N, NIdx) => (
                    <View key={NIdx} style={styles.NestlingBlock}>
                      <View style={styles.NestlingHeader}>
                        <Text style={styles.NestlingLabel}>{N.label}</Text>
                        {N.totalPriorBands > 0 && (
                          <Text style={styles.NestlingPrior}>
                            {N.totalPriorBands} prior band{N.totalPriorBands !== 1 ? 's' : ''}
                          </Text>
                        )}
                      </View>
                      {N.bandsThisCheck.map((B, BIdx) => (
                        <View key={BIdx} style={styles.BandRow}>
                          <Text style={styles.BandLabel}>
                            {B.band_type === 'federal' ? 'Federal ' : (B.band_color ? `${B.band_color} ` : 'Color ')}
                            {B.band_code}
                          </Text>
                          <IconButton
                            icon="close" size={16}
                            onPress={() => { MarkDirty(); setNestlings(Ns => Ns.map((Nn, I) =>
                              I === NIdx ? { ...Nn, bandsThisCheck: Nn.bandsThisCheck.filter((_, BI) => BI !== BIdx) } : Nn
                            )); }}
                            style={styles.BandDeleteBtn}
                          />
                        </View>
                      ))}
                      <Button
                        mode="text" compact icon="plus"
                        style={styles.AddNestlingBandBtn}
                        labelStyle={styles.AddNestlingBandLabel}
                        onPress={() => openAddNestlingBand(NIdx)}
                      >
                        Add band to {N.label}
                      </Button>
                    </View>
                  ))}
                  <Button
                    mode="outlined" compact icon="plus"
                    style={styles.AddBandBtn}
                    disabled={Nestlings.length >= YoungCount}
                    onPress={() => {
                      MarkDirty();
                      const NewLabel = `Nestling ${Nestlings.length + 1}`;
                      setNestlings(Ns => [...Ns, { id: null, label: NewLabel, bandsThisCheck: [], totalPriorBands: 0 }]);
                      openAddNestlingBand(Nestlings.length);
                    }}
                  >
                    Band a nestling{YoungCount > 0 ? ` (${YoungCount - Nestlings.length} remaining)` : ''}
                  </Button>

                  {/* Adults */}
                  <Text style={[styles.BandSubheader, styles.BandSubheaderSpaced]}>Adults</Text>
                  {AdultBands.map((B, Idx) => (
                    <View key={Idx} style={styles.BandRow}>
                      <Text style={styles.BandLabel}>
                        {B.bird_type === 'adult_male' ? 'Adult ♂' : 'Adult ♀'}
                        {' · '}{B.is_new_banding ? 'New' : 'Obs'}
                        {' · '}{B.band_type === 'federal' ? 'Federal ' : (B.band_color ? `${B.band_color} ` : 'Color ')}
                        {B.band_code}
                      </Text>
                      <IconButton
                        icon="close" size={16}
                        onPress={() => { MarkDirty(); setAdultBands(Ab => Ab.filter((_, I) => I !== Idx)); }}
                        style={styles.BandDeleteBtn}
                      />
                    </View>
                  ))}
                  <Button
                    mode="outlined" compact icon="plus"
                    style={styles.AddBandBtn}
                    onPress={() => {
                      setNewAdultBirdType('adult_male');
                      setNewAdultIsNew(true);
                      setNewBandType('federal');
                      setNewBandColor('');
                      setNewBandCode('');
                      setNewBandError('');
                      setAddAdultBandVisible(true);
                    }}
                  >
                    Add adult band
                  </Button>

                </View>
              )}
            </>
          );
        })()}

        {/* ── Dead adult (expandable) ──────────────────────────────── */}
        <View style={styles.ExpandRow}>
          <View style={styles.ExpandIconSpacer} />
          <Button
            mode="text" compact
            icon={DeadAdultExpanded ? 'chevron-up' : 'chevron-down'}
            contentStyle={styles.ExpandBtnContent}
            onPress={() => setDeadAdultExpanded(!DeadAdultExpanded)}
            style={styles.ExpandBtnInRow}
          >
            {L('Dead adult bird', 'DA')}{DeadAdultLabel ? ` · ${DeadAdultLabel}` : ''}
          </Button>
        </View>
        {DeadAdultExpanded && (
          <View style={styles.ExpandedSection}>
            <Checkbox.Item
              label="Dead male"
              status={DeadAdultMale ? 'checked' : 'unchecked'}
              onPress={() => { MarkDirty(); setDeadAdultMale(!DeadAdultMale); }}
              style={styles.CheckboxItem}
            />
            <Checkbox.Item
              label="Dead female"
              status={DeadAdultFemale ? 'checked' : 'unchecked'}
              onPress={() => { MarkDirty(); setDeadAdultFemale(!DeadAdultFemale); }}
              style={styles.CheckboxItem}
            />
          </View>
        )}

        {/* ── Notes (expandable) ──────────────────────────────────── */}
        <View style={styles.ExpandRow}>
          <View style={styles.ExpandIconSpacer} />
          <Button
            mode="text" compact
            icon={NotesExpanded ? 'chevron-up' : 'chevron-down'}
            contentStyle={styles.ExpandBtnContent}
            onPress={() => setNotesExpanded(!NotesExpanded)}
            style={styles.ExpandBtnInRow}
          >
            Notes{Notes.trim() ? ' · …' : ''}
          </Button>
        </View>
        {NotesExpanded && (
          <TextInput
            value={Notes}
            onChangeText={(T) => { MarkDirty(); setNotes(T); }}
            placeholder="Any additional observations"
            multiline
            style={styles.NotesInput}
          />
        )}

        {ErrorMessage ? <HelperText type="error" visible>{ErrorMessage}</HelperText> : null}

        {/* ── Actions ─────────────────────────────────────────────── */}
        <View style={styles.Actions}>
          <View style={styles.SaveRow}>
            <Button mode="contained" loading={Saving} onPress={handleSave} style={styles.ActionBtn}>
              {ExistingEntryId ? 'Update' : 'Save'}
            </Button>
            {NextCompartment && (
              <Button mode="outlined" loading={Saving} onPress={handleSaveAndNext} style={styles.ActionBtn}>
                Save & Next
              </Button>
            )}
          </View>
          {ExistingEntryId && (
            <Button
              mode="outlined" textColor="red"
              style={[styles.ActionBtn, styles.DeleteBtn]}
              onPress={() => setDeleteVisible(true)}
            >
              Delete entry
            </Button>
          )}
        </View>

      </ScrollView>

      <Portal>
        {/* ── Add Nestling Band ────────────────────────────────────── */}
        <Dialog visible={AddNestlingBandVisible} onDismiss={handleCancelNestlingBand}>
          <Dialog.Title>
            {AddNestlingBandIdx !== null && Nestlings[AddNestlingBandIdx]
              ? `Band: ${Nestlings[AddNestlingBandIdx].label}`
              : 'Add Nestling Band'}
          </Dialog.Title>
          <Dialog.ScrollArea style={styles.BandDialogScroll}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.BandFormLabel}>Band type</Text>
              <RadioButton.Group value={NewBandType} onValueChange={v => setNewBandType(v as 'federal' | 'color')}>
                <RadioButton.Item label="Federal (USFWS silver)" value="federal" style={styles.RadioItem} />
                <RadioButton.Item label="Color band"             value="color"   style={styles.RadioItem} />
              </RadioButton.Group>
              {NewBandType === 'color' && (
                <TextInput
                  label="Band color"
                  value={NewBandColor}
                  onChangeText={setNewBandColor}
                  placeholder="e.g. Red, Blue, Green"
                  style={styles.BandInput}
                />
              )}
              <TextInput
                label={NewBandType === 'federal' ? 'Band number (e.g. 2841-74209)' : 'Band code (e.g. TX 403)'}
                value={NewBandCode}
                onChangeText={setNewBandCode}
                autoCapitalize="characters"
                style={styles.BandInput}
              />
              {NewBandError ? <HelperText type="error" visible>{NewBandError}</HelperText> : null}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={handleCancelNestlingBand}>Cancel</Button>
            <Button onPress={handleConfirmNestlingBand}>Add</Button>
          </Dialog.Actions>
        </Dialog>

        {/* ── Add Adult Band ───────────────────────────────────────── */}
        <Dialog visible={AddAdultBandVisible} onDismiss={() => setAddAdultBandVisible(false)}>
          <Dialog.Title>Add Adult Band</Dialog.Title>
          <Dialog.ScrollArea style={styles.BandDialogScroll}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.BandFormLabel}>Bird</Text>
              <RadioButton.Group value={NewAdultBirdType} onValueChange={v => setNewAdultBirdType(v as AdultBand['bird_type'])}>
                <RadioButton.Item label="Adult male"   value="adult_male"   style={styles.RadioItem} />
                <RadioButton.Item label="Adult female" value="adult_female" style={styles.RadioItem} />
              </RadioButton.Group>
              <Text style={styles.BandFormLabel}>Event</Text>
              <RadioButton.Group value={NewAdultIsNew ? 'new' : 'observed'} onValueChange={v => setNewAdultIsNew(v === 'new')}>
                <RadioButton.Item label="Newly banded"           value="new"      style={styles.RadioItem} />
                <RadioButton.Item label="Observed existing band" value="observed" style={styles.RadioItem} />
              </RadioButton.Group>
              <Text style={styles.BandFormLabel}>Band type</Text>
              <RadioButton.Group value={NewBandType} onValueChange={v => setNewBandType(v as 'federal' | 'color')}>
                <RadioButton.Item label="Federal (USFWS silver)" value="federal" style={styles.RadioItem} />
                <RadioButton.Item label="Color band"             value="color"   style={styles.RadioItem} />
              </RadioButton.Group>
              {NewBandType === 'color' && (
                <TextInput
                  label="Band color"
                  value={NewBandColor}
                  onChangeText={setNewBandColor}
                  placeholder="e.g. Red, Blue, Green"
                  style={styles.BandInput}
                />
              )}
              <TextInput
                label={NewBandType === 'federal' ? 'Band number (e.g. 2841-74209)' : 'Band code (e.g. TX 403)'}
                value={NewBandCode}
                onChangeText={setNewBandCode}
                autoCapitalize="characters"
                style={styles.BandInput}
              />
              {NewBandError ? <HelperText type="error" visible>{NewBandError}</HelperText> : null}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setAddAdultBandVisible(false)}>Cancel</Button>
            <Button onPress={handleConfirmAdultBand}>Add</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={RenestingDialogVisible} onDismiss={handleRenestingCancel}>
          <Dialog.Title>Renesting Attempt</Dialog.Title>
          <Dialog.Content>
            {RenestingCandidates.length <= 1 ? (() => {
              const C = RenestingCandidates[0];
              if (!C) return null;
              const net = Math.max(0, C.egg_count - C.discarded_eggs);
              if (net === 0) {
                const wereDiscarded = C.discarded_eggs > 0 || C.nest_discarded;
                return (
                  <Text>
                    {wereDiscarded
                      ? `Based on previous checks, all eggs in the nest were discarded by the ${formatDate(C.check_date)} check, leaving it empty.`
                      : `Based on previous checks, no eggs were present at the ${formatDate(C.check_date)} check.`
                    }{' '}The new clutch began after that date. Only this entry and any later checks will be tagged as Attempt 2.
                  </Text>
                );
              }
              return (
                <Text>
                  Based on previous checks, the new clutch appears to have started around{' '}
                  {formatDate(C.check_date)}. Entries from that check through this one will
                  be tagged as Attempt 2.
                </Text>
              );
            })() : (
              <>
                <Text style={{ marginBottom: 8 }}>
                  It is unclear exactly when the new clutch began. Select the check that most
                  likely marks the start of the renesting attempt:
                </Text>
                <RadioButton.Group
                  value={SelectedSplitDate ?? ''}
                  onValueChange={v => setSelectedSplitDate(v)}
                >
                  {RenestingCandidates.map(C => {
                    const Parts = [`${C.egg_count} egg${C.egg_count !== 1 ? 's' : ''}`];
                    if (C.discarded_eggs > 0) Parts.push(`${C.discarded_eggs} discarded`);
                    if (C.nest_discarded && C.species !== 'PM') Parts.push(`${SpeciesLabel[C.species] ?? C.species} nest discarded`);
                    return (
                      <RadioButton.Item
                        key={C.check_date}
                        label={`${formatDate(C.check_date)} · ${Parts.join(' · ')}`}
                        value={C.check_date}
                        style={styles.RadioItem}
                      />
                    );
                  })}
                </RadioButton.Group>
                {SelectedSplitDate && (() => {
                  const sel = RenestingCandidates.find(c => c.check_date === SelectedSplitDate);
                  const net = sel ? Math.max(0, sel.egg_count - sel.discarded_eggs) : 0;
                  if (net === 0) {
                    const wereDiscarded = sel ? (sel.discarded_eggs > 0 || sel.nest_discarded) : false;
                    return (
                      <Text style={{ marginTop: 8, fontSize: 13, color: '#666' }}>
                        {wereDiscarded
                          ? `All eggs were discarded at the ${formatDate(SelectedSplitDate)} check, leaving the nest empty.`
                          : `No eggs were present at the ${formatDate(SelectedSplitDate)} check.`
                        }{' '}Only entries after that check will be tagged as Attempt 2.
                      </Text>
                    );
                  }
                  return (
                    <Text style={{ marginTop: 8, fontSize: 13, color: '#666' }}>
                      Entries from {formatDate(SelectedSplitDate)} through this check will be tagged as Attempt 2.
                    </Text>
                  );
                })()}
              </>
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={handleRenestingCancel}>Cancel</Button>
            <Button onPress={handleRenestingConfirm}>Confirm</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={AbandonVisible} onDismiss={() => setAbandonVisible(false)}>
          <Dialog.Title>Discard changes?</Dialog.Title>
          <Dialog.Content>
            <Text>You have unsaved changes. Go back and discard them?</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAbandonVisible(false)}>Keep editing</Button>
            <Button textColor="red" onPress={() => {
              ClearDirty();
              setAbandonVisible(false);
              navigation.goBack();
            }}>Discard</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={DeleteVisible} onDismiss={() => setDeleteVisible(false)}>
          <Dialog.Title>Delete this entry?</Dialog.Title>
          <Dialog.Content>
            <Text>
              This will permanently remove the data recorded for this compartment during this check.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteVisible(false)}>Cancel</Button>
            <Button textColor="red" loading={Deleting} onPress={handleDelete}>Delete</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  Loading:           { flex: 1, justifyContent: 'center', alignItems: 'center' },
  Container:         { padding: 16, paddingBottom: 40 },
  PrevBanner:        { color: '#888', fontStyle: 'italic', marginBottom: 4 },
  HatchBanner:       { color: '#444', fontWeight: '500', marginBottom: 4 },
  DateStats:         { marginBottom: 12 },
  DateStat:          { fontSize: 13, color: '#444', marginBottom: 2 },
  CalcAge:           { fontSize: 14, color: '#333', fontWeight: '500', marginVertical: 4 },
  SpeciesRow:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  SpeciesCurrent:    { fontWeight: '600', fontSize: 15 },
  SpeciesBtnContent: { flexDirection: 'row-reverse' },
  Divider:           { marginVertical: 12 },
  CountersRow:       { flexDirection: 'row', gap: 16, marginBottom: 4 },
  Counter:           { alignItems: 'center', flex: 1 },
  CounterLabel:      { fontSize: 13, color: '#444', marginBottom: 2 },
  CounterControls:   { flexDirection: 'row', alignItems: 'center' },
  StepBtn:           { margin: 0 },
  CounterInput: {
    width: 44, fontSize: 22, fontWeight: '600', textAlign: 'center',
    borderWidth: 1.5, borderColor: '#888', borderRadius: 4,
    paddingHorizontal: 4, paddingVertical: 4, color: '#000',
  },
  PrevBtn:           { marginTop: 6, alignSelf: 'center' },
  PrevBtnLabel:      { fontSize: 12, marginVertical: 2, marginHorizontal: 4 },
  CheckboxItem:      { paddingVertical: 0 },
  DeadYoungRow:      { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  ExpandBtn:         { alignSelf: 'flex-start', marginTop: 4 },
  ExpandBtnContent:  { flexDirection: 'row-reverse' },
  ExpandRow:         { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: 4 },
  ExpandBtnInRow:    {},
  ExpandIconSpacer:  { width: 16 },
  ExpandedSection:   { paddingLeft: 8 },
  NotesInput:        { marginTop: 8 },
  AgeRow:            { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  AgeSexLabel:       { width: 56, fontSize: 13, color: '#444' },
  AgeChips:          { flexDirection: 'row', gap: 6 },
  AgeChip:           { alignSelf: 'flex-start' },
  AgeChipLabel:      { fontSize: 12, marginHorizontal: 6, marginVertical: 2 },
  AgeConfirmed:      { fontSize: 11, color: '#2e7d32', fontWeight: '500', marginTop: 3 },
  AgeCount:          { fontSize: 11, color: '#888', marginTop: 3 },
  Actions:           { marginTop: 20, gap: 8 },
  SaveRow:           { flexDirection: 'row', gap: 12 },
  ActionBtn:         { flex: 1 },
  DeleteBtn:         { borderColor: 'red' },
  BandSubheader:        { fontWeight: '600', fontSize: 13, color: '#444', marginTop: 4, marginBottom: 4 },
  BandSubheaderSpaced:  { marginTop: 12 },
  NestlingBlock:        { marginBottom: 8, paddingLeft: 4, borderLeftWidth: 2, borderLeftColor: '#ddd' },
  NestlingHeader:       { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  NestlingLabel:        { fontWeight: '600', fontSize: 13, color: '#222' },
  NestlingPrior:        { fontSize: 11, color: '#888' },
  AddNestlingBandBtn:   { alignSelf: 'flex-start', marginTop: 2 },
  AddNestlingBandLabel: { fontSize: 12, marginHorizontal: 4, marginVertical: 2 },
  BandRow:              { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  BandLabel:            { flex: 1, fontSize: 13, color: '#333' },
  BandDeleteBtn:        { margin: 0 },
  AddBandBtn:           { alignSelf: 'flex-start', marginTop: 4 },
  BandDialogScroll:     { maxHeight: 440 },
  BandFormLabel:        { fontWeight: '600', fontSize: 13, marginTop: 12, marginBottom: 2, paddingHorizontal: 4 },
  BandInput:            { marginTop: 8, marginBottom: 4 },
  RadioItem:            { paddingVertical: 0 },
});
