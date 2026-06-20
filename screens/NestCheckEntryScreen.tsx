import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput as RNTextInput, View, useWindowDimensions } from 'react-native';
import {
  Button, Checkbox, Dialog, Divider, HelperText,
  Icon, IconButton, Portal, RadioButton, Text, TextInput, TouchableRipple,
} from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { friendlyError } from '../lib/errorUtils';
import { AppStackParamList } from '../App';
import { useSettings } from '../contexts/SettingsContext';
import { useSync } from '../contexts/SyncContext';
import { SpeciesLabel, formatDate, addDays, computeConfirmedAge, incrementBandCode, validateFederalBandCode } from '../lib/nestLogic';
import {
  getLocalEntriesForCompartment,
  cacheEntries, getLocalEntry,
  getLocalNestlings, cacheNestlings,
  getLocalBands, cacheBands, getLocalPriorBandCounts,
  upsertLocalEntry, upsertLocalNestling, replaceLocalBands,
  upsertLocalNestSeason, deleteLocalEntry, makeId, setLocalEntriesNestingAttempt,
  resetLocalNestingAttemptsForCompartment, lookupLocalBandLocation, getLocalPriorBandDetails,
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
  dead_young_count: number;
  nesting_attempt: number;
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
  group_id: string;   // client-side only — groups bands that belong to the same observed bird
};

const SpeciesList = [
  { label: 'Purple Martin',     value: 'PM' },
  { label: 'House Sparrow',     value: 'HS' },
  { label: 'European Starling', value: 'ST' },
  { label: 'Tree Swallow',      value: 'TS' },
  { label: 'Bluebird',          value: 'BB' },
  { label: 'House Wren',        value: 'HW' },
];


// ── Counter ────────────────────────────────────────────────────────────────
function Counter({
  label, value, onChange, prevValue, horizontal,
}: {
  label: React.ReactNode; value: number; onChange: (n: number) => void; prevValue?: number | null; horizontal?: boolean;
}) {
  return (
    <View style={horizontal ? styles.CounterH : styles.Counter}>
      {!!label && <Text style={horizontal ? styles.CounterLabelH : styles.CounterLabel}>{label}</Text>}
      <View style={styles.CounterControls}>
        <IconButton icon="minus" size={14} mode="contained" containerColor="#c62828" iconColor="#fff" onPress={() => onChange(Math.max(0, value - 1))} style={styles.StepBtn} />
        <RNTextInput
          value={String(value)}
          onChangeText={(T) => { const N = parseInt(T, 10); onChange(isNaN(N) || N < 0 ? 0 : N); }}
          keyboardType="numeric"
          selectTextOnFocus
          style={styles.CounterInput}
        />
        <IconButton icon="plus" size={14} mode="contained" containerColor="#2e7d32" iconColor="#fff" onPress={() => onChange(value + 1)} style={styles.StepBtn} />
      </View>
      {prevValue != null && (
        <Button
          mode="outlined"
          compact
          onPress={() => onChange(prevValue)}
          style={horizontal ? styles.PrevBtnH : styles.PrevBtn}
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
  const { CheckId, CheckDate, SeasonId, SiteId, CompartmentId, HousingType, ExistingEntryId, AllCompartments, CompartmentIndex } = route.params;
  const IsGourd = HousingType === 'AG' || HousingType === 'NG';
  const NextCompartment = (AllCompartments && CompartmentIndex !== undefined && CompartmentIndex < AllCompartments.length - 1)
    ? AllCompartments[CompartmentIndex + 1]
    : null;
  const { CompactMode, toggleCompactMode, BandingEnabled } = useSettings();
  const { isOnline, syncNow } = useSync();
  const { height: ScreenHeight } = useWindowDimensions();
  function L(full: string, compact: string) { return CompactMode ? compact : full; }

  const [BandKeyboardHeight, setBandKeyboardHeight] = useState(0);

  // Refs so Portal-hosted dialogs always call the latest handler even when
  // TextInput changes cause re-renders that don't propagate into the Portal tree.
  const ConfirmNestlingBandRef = useRef<() => void>(() => {});
  const ConfirmAdultBandRef    = useRef<() => void>(() => {});

  // ── Species ──────────────────────────────────────────────────────────
  const [SpeciesVal, setSpeciesVal]           = useState('PM');
  const [SpeciesExpanded, setSpeciesExpanded] = useState(false);

  // ── Status ───────────────────────────────────────────────────────────
  const [GourdRemoved, setGourdRemoved] = useState(false);
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
  const AllPriorEntriesRef = useRef<{ id: string; nest_check_id: string; check_date: string; egg_count: number; discarded_eggs: number; young_count: number; nestling_age_days: number | null; adult_present: boolean; is_empty_cavity: boolean; has_nest: boolean; nest_discarded: boolean; renesting_attempt: boolean; species: string; nesting_attempt: number }[]>([]);

  // ── Nest management ───────────────────────────────────────────────────
  const [NestDiscarded, setNestDiscarded] = useState(false);
  const [NestReplaced, setNestReplaced]   = useState(false);

  // ── Adult bird ages ───────────────────────────────────────────────────
  const [ObservedMaleAge, setObservedMaleAge]         = useState<'SY' | 'ASY' | 'UNK' | null>(null);
  const [ObservedFemaleAge, setObservedFemaleAge]     = useState<'SY' | 'ASY' | 'UNK' | null>(null);
  const [AgeConfirmInfoVisible, setAgeConfirmInfoVisible] = useState(false);
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
  const [EditNestlingBandIdx, setEditNestlingBandIdx]       = useState<number | null>(null); // band index within nestling
  const [AddAdultBandVisible, setAddAdultBandVisible]       = useState(false);
  const [EditAdultBandIdx, setEditAdultBandIdx]             = useState<number | null>(null);
  const [PendingAdultGroupId, setPendingAdultGroupId]       = useState<string | null>(null);
  const [NewBandType, setNewBandType]                       = useState<'federal' | 'color'>('federal');
  const [NewBandColor, setNewBandColor]                     = useState('');
  const [NewBandCode, setNewBandCode]                       = useState('');
  const [NewBandError, setNewBandError]                     = useState('');
  const [NewAdultBirdType, setNewAdultBirdType]             = useState<'adult_male' | 'adult_female'>('adult_male');
  const [NewAdultIsNew, setNewAdultIsNew]                   = useState(true);
  const [LastFederalCode, setLastFederalCode]               = useState<string | null>(null);
  const [LastColorCode, setLastColorCode]                   = useState<string | null>(null);
  const [LastColorBandColor, setLastColorBandColor]         = useState<string | null>(null);
  const [BandLookupPending, setBandLookupPending]           = useState(false);
  const [BandWarning, setBandWarning]                       = useState<string | null>(null);
  const [BandPermitAcknowledged, setBandPermitAcknowledged] = useState(false);
  const [BandPermitDialogVisible, setBandPermitDialogVisible] = useState(false);
  const [BandPermitChecked, setBandPermitChecked]           = useState(false);
  const PendingBandAction = useRef<(() => void) | null>(null);
  type PriorBandDetail = { band_type: string; band_color: string | null; band_code: string; check_date: string };
  const [PriorBandsInfoVisible, setPriorBandsInfoVisible]   = useState(false);
  const [PriorBandsInfoLabel, setPriorBandsInfoLabel]       = useState('');
  const [PriorBandsInfoData, setPriorBandsInfoData]         = useState<PriorBandDetail[] | null>(null);
  const [PriorBandsInfoLoading, setPriorBandsInfoLoading]   = useState(false);

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
  const [AgeSourceDate, setAgeSourceDate]             = useState<string | null>(null);
  const [AgeInfoVisible, setAgeInfoVisible]           = useState(false);

  // ── Loading / saving / deleting ───────────────────────────────────────
  const [InitLoading, setInitLoading]         = useState(!!ExistingEntryId);
  const [ContextLoaded, setContextLoaded]     = useState(false);
  const RepairRanRef                          = useRef(false);
  const [Saving, setSaving]               = useState(false);
  const [DeleteVisible, setDeleteVisible] = useState(false);
  const [Deleting, setDeleting]           = useState(false);
  const [ErrorMessage, setErrorMessage]   = useState('');
  const [FledgePromptVisible, setFledgePromptVisible] = useState(false);
  const [FledgePromptCount, setFledgePromptCount]     = useState(0);
  const FledgeSaveAndNextRef = useRef(false);
  const ScrollViewRef        = useRef<ScrollView>(null);
  const NestlingBandScrollRef = useRef<ScrollView>(null);
  const AdultBandScrollRef    = useRef<ScrollView>(null);

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

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', e => setBandKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setBandKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    AsyncStorage.multiGet(['band_last_federal_code', 'band_last_color_code', 'band_last_color_band_color', 'banding_permit_acknowledged'])
      .then(([[, fed], [, col], [, colColor], [, ack]]) => {
        if (fed) setLastFederalCode(fed);
        if (col) setLastColorCode(col);
        setLastColorBandColor(colColor ?? null);
        if (ack === 'true') setBandPermitAcknowledged(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (AddAdultBandVisible && (NewBandError || BandWarning)) {
      setTimeout(() => AdultBandScrollRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [NewBandError, BandWarning, AddAdultBandVisible]);

  useEffect(() => {
    if (AddNestlingBandVisible && BandWarning) {
      setTimeout(() => NestlingBandScrollRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [BandWarning, AddNestlingBandVisible]);

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
              {ExistingEntryId ? 'Update' : 'Save'}
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

  // Auto-repair: if an RA entry was saved with nesting_attempt=1 (debugging corruption),
  // correct it to 2 and tag future entries once both loads have finished.
  useEffect(() => {
    if (InitLoading || !ContextLoaded || RepairRanRef.current) return;
    if (!ExistingEntryId || !Renesting || NestingAttempt > 1) return;
    RepairRanRef.current = true;
    setNestingAttempt(2);
    MarkDirty();
    tagFutureEntriesAsNextAttempt(2).catch(() => {});
  }, [InitLoading, ContextLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recompute attempt-scoped date stats whenever the attempt or loaded data changes.
  // Scoping to the current nesting_attempt means Attempt 2 shows its own first-egg
  // and hatch dates, not those from Attempt 1. Also detects young that vanished before
  // fledge age (26 days) and treats them as dead so projections aren't carried forward.
  useEffect(() => {
    if (!ContextLoaded) return;
    if (ExistingEntryId && InitLoading) return;

    type E = typeof AllPriorEntriesRef.current[0];
    const IsUnchecked = (e: E) =>
      e.adult_present ||
      (!e.is_empty_cavity && !e.has_nest &&
       e.egg_count === 0 && e.discarded_eggs === 0 && e.young_count === 0 && !e.nest_discarded);

    const EWD = AllPriorEntriesRef.current
      .filter(e => e.nesting_attempt === NestingAttempt && !IsUnchecked(e))
      .sort((a, b) => a.check_date.localeCompare(b.check_date));

    // First egg date range for this attempt
    const FirstWithEggs = EWD.find(e => e.egg_count > 0);
    if (FirstWithEggs) {
      const LastEmpty = [...EWD].filter(e => e.egg_count === 0 && e.check_date < FirstWithEggs.check_date).pop();
      const LatestFirst   = addDays(FirstWithEggs.check_date, -(FirstWithEggs.egg_count - 1));
      const EarliestFirst = LastEmpty ? addDays(LastEmpty.check_date, 1) : null;
      const MinFirst = (EarliestFirst && EarliestFirst <= LatestFirst) ? EarliestFirst : LatestFirst;
      setFirstEggRange({ min: MinFirst, max: LatestFirst });
      const MaxEggs = Math.max(...EWD.map(e => e.egg_count));
      setProjectedHatchRange({
        min: addDays(MinFirst,    MaxEggs - 1 + 15),
        max: addDays(LatestFirst, MaxEggs - 1 + 15),
      });
    } else {
      setFirstEggRange(null);
      setProjectedHatchRange(null);
    }

    // Hatch anchor: earliest entry in this attempt with young + recorded nestling age
    let FoundHatch = false;
    for (const AnchorE of EWD) {
      if (AnchorE.young_count > 0 && AnchorE.nestling_age_days != null) {
        const [ay, am, ad] = AnchorE.check_date.split('-').map(Number);
        const Hatch = new Date(ay, am - 1, ad);
        Hatch.setDate(Hatch.getDate() - AnchorE.nestling_age_days!);
        const HatchStr  = `${Hatch.getFullYear()}-${String(Hatch.getMonth() + 1).padStart(2, '0')}-${String(Hatch.getDate()).padStart(2, '0')}`;
        const ProjFledgeStr = addDays(HatchStr, 26);

        // If young went to zero before the projected fledge date, treat them as dead.
        // Only look at entries between the anchor and the current check date.
        const YoungDied = EWD
          .filter(f => f.check_date > AnchorE.check_date && f.check_date < CheckDate)
          .some(f => f.young_count === 0 && f.check_date < ProjFledgeStr);

        if (YoungDied) {
          setActualHatchDate(null);
          setProjectedFledgeDate(null);
          setCalculatedNestlingAge(null);
          setAgeSourceDate(null);
        } else {
          setActualHatchDate(HatchStr);
          setProjectedFledgeDate(ProjFledgeStr);
          const [cy, cm, cd] = CheckDate.split('-').map(Number);
          const DiffDays = Math.round((new Date(cy, cm - 1, cd).getTime() - Hatch.getTime()) / 86400000);
          setCalculatedNestlingAge(DiffDays > 0 ? DiffDays : null);
          setAgeSourceDate(DiffDays > 0 ? AnchorE.check_date : null);
        }
        FoundHatch = true;
        break;
      }
    }
    if (!FoundHatch) {
      setActualHatchDate(null);
      setProjectedFledgeDate(null);
      setCalculatedNestlingAge(null);
      setAgeSourceDate(null);
    }
  }, [ContextLoaded, InitLoading, NestingAttempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch season context: prev-entry banner + hatch-date for nestling age
  useEffect(() => {
    async function fetchSeasonContext() {
      const YearStr = CheckDate.substring(0, 4);

      // Flat list of other entries for this compartment in this season, with check_date
      type SeasonEntry = {
        id: string; check_date: string; species: string;
        is_empty_cavity: boolean | number; has_nest: boolean | number;
        nest_discarded: boolean | number; adult_present: boolean | number;
        egg_count: number; discarded_eggs: number; young_count: number; dead_young_count: number;
        nestling_age_days: number | null;
        observed_male_age: string | null; observed_female_age: string | null;
        nesting_attempt: number; renesting_attempt: boolean | number;
        nest_check_id: string;
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
          .select('id, nest_check_id, species, is_empty_cavity, has_nest, nest_discarded, adult_present, renesting_attempt, egg_count, discarded_eggs, young_count, dead_young_count, nestling_age_days, observed_male_age, observed_female_age, nesting_attempt')
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
        nest_check_id: (e as any).nest_check_id ?? '',
        check_date: e.check_date,
        species: e.species,
        egg_count: e.egg_count,
        discarded_eggs: e.discarded_eggs ?? 0,
        young_count: e.young_count ?? 0,
        nestling_age_days: (e as any).nestling_age_days ?? null,
        adult_present: !!(e as any).adult_present,
        is_empty_cavity: !!e.is_empty_cavity,
        has_nest: !!e.has_nest,
        nest_discarded: !!e.nest_discarded,
        renesting_attempt: !!(e as any).renesting_attempt,
        nesting_attempt: (e as any).nesting_attempt ?? 1,
      }));

      // For a new entry, default NestingAttempt to whatever the most recent prior
      // entry is using — so checks after an RA start at the correct attempt number.
      if (!ExistingEntryId) {
        const LastPrior = [...AllPriorEntriesRef.current]
          .filter(e => e.check_date < CheckDate)
          .sort((a, b) => b.check_date.localeCompare(a.check_date))[0];
        if (LastPrior) setNestingAttempt(LastPrior.nesting_attempt);
      }

      setPriorEggsSeen(Entries.some(e => (e.egg_count ?? 0) > 0));
      setPriorYoungSeen(Entries.some(e => (e.young_count ?? 0) > 0));

      const MaleObs   = Entries.map(e => e.observed_male_age ?? null);
      const FemaleObs = Entries.map(e => e.observed_female_age ?? null);
      setOtherMaleObs(MaleObs);
      setOtherFemaleObs(FemaleObs);
      // Adult ages section stays closed by default

      // Prev entry: most recent entry before current date that actually checked the nest
      // (skip adult_present observations and entries with nothing nest-related recorded)
      const Prev = [...Entries]
        .filter(e => {
          if (e.check_date >= CheckDate) return false;
          if ((e as any).adult_present) return false;
          if (!e.is_empty_cavity && !e.has_nest &&
              e.egg_count === 0 && (e.discarded_eggs ?? 0) === 0 &&
              e.young_count === 0 && !e.nest_discarded) return false;
          return true;
        })
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
          dead_young_count: (Prev as any).dead_young_count ?? 0,
          nesting_attempt:  (Prev as any).nesting_attempt ?? 1,
        });
      }

    }
    fetchSeasonContext().finally(() => setContextLoaded(true));
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
      setGourdRemoved(!!(E as any).gourd_removed);
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
          group_id:       makeId(),
        }));

      setNestlings(records);
      setAdultBands(adultBands);
      // Banding section stays closed by default
    }
    loadBandingContext();
  }, [CompartmentId, SeasonId, ExistingEntryId]);

  // ── Banding helpers ────────────────────────────────────────────────────

  async function lookupBandLocation(bandCode: string): Promise<{
    site?: string; unit: string; cavity: string; date: string;
  } | null> {
    try {
      if (isOnline) {
        // Step 1: band → entry → compartment → unit
        const { data: bandRow } = await supabase
          .from('bands')
          .select(`
            nest_check_entries!inner(
              nest_check_id,
              compartments!inner(cavity_label, housing_units!inner(name))
            )
          `)
          .eq('band_code', bandCode)
          .eq('is_new_banding', true)
          .limit(1)
          .maybeSingle();
        if (!bandRow) return null;
        const entry = (bandRow as any).nest_check_entries;
        const comp  = entry?.compartments;
        // Step 2: nest_check → site
        const { data: checkRow } = await supabase
          .from('nest_checks')
          .select('check_date, sites!inner(name)')
          .eq('id', entry?.nest_check_id)
          .maybeSingle();
        return {
          site:   (checkRow as any)?.sites?.name,
          unit:   comp?.housing_units?.name ?? 'Unknown unit',
          cavity: comp?.cavity_label ?? '?',
          date:   checkRow?.check_date ?? '?',
        };
      } else {
        return await lookupLocalBandLocation(bandCode);
      }
    } catch {
      return null;
    }
  }

  function locationString(loc: { site?: string; unit: string; cavity: string; date: string }): string {
    const parts: string[] = [];
    if (loc.site) parts.push(loc.site);
    parts.push(`${loc.unit}, compartment ${loc.cavity}`);
    parts.push(formatDate(loc.date));
    return parts.join(' · ');
  }

  function guardBandAction(action: () => void) {
    if (BandPermitAcknowledged) { action(); return; }
    PendingBandAction.current = action;
    setBandPermitChecked(false);
    setBandPermitDialogVisible(true);
  }

  function confirmBandPermit() {
    if (!BandPermitChecked) return;
    AsyncStorage.setItem('banding_permit_acknowledged', 'true').catch(() => {});
    setBandPermitAcknowledged(true);
    setBandPermitDialogVisible(false);
    PendingBandAction.current?.();
    PendingBandAction.current = null;
  }

  function openAddNestlingBand(Idx: number) {
    setAddNestlingBandIdx(Idx);
    setEditNestlingBandIdx(null);
    setNewBandType('federal');
    setNewBandColor('');
    setNewBandCode('');
    setNewBandError('');
    setBandWarning(null);
    setAddNestlingBandVisible(true);
  }

  function openEditNestlingBand(NIdx: number, BIdx: number) {
    const Band = Nestlings[NIdx].bandsThisCheck[BIdx];
    setAddNestlingBandIdx(NIdx);
    setEditNestlingBandIdx(BIdx);
    setNewBandType(Band.band_type);
    setNewBandColor(Band.band_color ?? '');
    setNewBandCode(Band.band_code);
    setNewBandError('');
    setBandWarning(null);
    setAddNestlingBandVisible(true);
  }

  function handleCancelNestlingBand() {
    if (EditNestlingBandIdx === null && AddNestlingBandIdx !== null) {
      const N = Nestlings[AddNestlingBandIdx];
      if (N && N.id === null && N.bandsThisCheck.length === 0) {
        setNestlings(Ns => Ns.filter((_, I) => I !== AddNestlingBandIdx));
      }
    }
    setEditNestlingBandIdx(null);
    setAddNestlingBandVisible(false);
  }

  function commitNestlingBand() {
    if (AddNestlingBandIdx === null) return;
    MarkDirty();
    const Code = NewBandCode.trim().toUpperCase();
    const Band: NestlingBand = {
      band_type:  NewBandType,
      band_color: NewBandType === 'color' ? (NewBandColor.trim() || null) : null,
      band_code:  Code,
    };
    if (EditNestlingBandIdx !== null) {
      const BIdx = EditNestlingBandIdx;
      setNestlings(Ns => Ns.map((N, I) =>
        I === AddNestlingBandIdx
          ? { ...N, bandsThisCheck: N.bandsThisCheck.map((B, BI) => BI === BIdx ? Band : B) }
          : N
      ));
    } else {
      setNestlings(Ns => Ns.map((N, I) =>
        I === AddNestlingBandIdx ? { ...N, bandsThisCheck: [...N.bandsThisCheck, Band] } : N
      ));
      if (NewBandType === 'federal') {
        setLastFederalCode(Code);
        AsyncStorage.setItem('band_last_federal_code', Code).catch(() => {});
      } else {
        const ColorTrimmed = NewBandColor.trim();
        setLastColorCode(Code);
        setLastColorBandColor(ColorTrimmed || null);
        AsyncStorage.setItem('band_last_color_code', Code).catch(() => {});
        if (ColorTrimmed) AsyncStorage.setItem('band_last_color_band_color', ColorTrimmed).catch(() => {});
        else AsyncStorage.removeItem('band_last_color_band_color').catch(() => {});
      }
    }
    setBandWarning(null);
    setEditNestlingBandIdx(null);
    setAddNestlingBandVisible(false);
  }

  async function handleConfirmNestlingBand() {
    const Code = NewBandCode.trim();
    if (!Code) { setNewBandError('Please enter a band number or code.'); return; }
    if (NewBandType === 'federal' && EditNestlingBandIdx === null) {
      const Err = validateFederalBandCode(Code);
      if (Err) { setNewBandError(Err); return; }
      const Digits = Code.replace(/-/g, '').length;
      const is8Digit = Digits === 8;
      setBandLookupPending(true);
      const existing = await lookupBandLocation(Code.toUpperCase());
      setBandLookupPending(false);
      if (existing || is8Digit) {
        const lines: string[] = [];
        if (existing) lines.push(`Band ${Code.toUpperCase()} was already assigned at ${locationString(existing)}.`);
        if (is8Digit) lines.push(`This band has ${Digits} digits — federal bands should have 8 or 9 digits. Are you sure no digits are missing?`);
        setBandWarning(lines.join('\n\n'));
        return;
      }
    }
    commitNestlingBand();
  }

  function openEditAdultBand(Idx: number) {
    const Band = AdultBands[Idx];
    setEditAdultBandIdx(Idx);
    setNewAdultBirdType(Band.bird_type);
    setNewAdultIsNew(Band.is_new_banding);
    setNewBandType(Band.band_type);
    setNewBandColor(Band.band_color ?? '');
    setNewBandCode(Band.band_code);
    setNewBandError('');
    setBandWarning(null);
    setAddAdultBandVisible(true);
  }

  function commitAdultBand() {
    MarkDirty();
    const Code = NewBandCode.trim().toUpperCase();
    const Band: AdultBand = {
      is_new_banding: NewAdultIsNew,
      bird_type:      NewAdultBirdType,
      band_type:      NewBandType,
      band_color:     NewBandType === 'color' ? (NewBandColor.trim() || null) : null,
      band_code:      Code,
      group_id:       EditAdultBandIdx !== null
        ? AdultBands[EditAdultBandIdx].group_id
        : (PendingAdultGroupId ?? makeId()),
    };
    if (EditAdultBandIdx !== null) {
      const Idx = EditAdultBandIdx;
      setAdultBands(Ab => Ab.map((B, I) => I === Idx ? Band : B));
    } else {
      setAdultBands(Ab => [...Ab, Band]);
      if (NewBandType === 'federal') {
        setLastFederalCode(Code);
        AsyncStorage.setItem('band_last_federal_code', Code).catch(() => {});
      } else {
        const ColorTrimmed = NewBandColor.trim();
        setLastColorCode(Code);
        setLastColorBandColor(ColorTrimmed || null);
        AsyncStorage.setItem('band_last_color_code', Code).catch(() => {});
        if (ColorTrimmed) AsyncStorage.setItem('band_last_color_band_color', ColorTrimmed).catch(() => {});
        else AsyncStorage.removeItem('band_last_color_band_color').catch(() => {});
      }
    }
    setBandWarning(null);
    setEditAdultBandIdx(null);
    setPendingAdultGroupId(null);
    setAddAdultBandVisible(false);
  }

  async function handleConfirmAdultBand() {
    const Code = NewBandCode.trim();
    if (!Code) { setNewBandError('Please enter a band number or code.'); return; }
    if (NewBandType === 'federal') {
      if (NewAdultIsNew && EditAdultBandIdx === null) {
        const Err = validateFederalBandCode(Code);
        if (Err) { setNewBandError(Err); return; }
        const Digits = Code.replace(/-/g, '').length;
        const is8Digit = Digits === 8;
        setBandLookupPending(true);
        const existing = await lookupBandLocation(Code.toUpperCase());
        setBandLookupPending(false);
        if (existing || is8Digit) {
          const lines: string[] = [];
          if (existing) lines.push(`Band ${Code.toUpperCase()} was already assigned at ${locationString(existing)}.`);
          if (is8Digit) lines.push(`This band has ${Digits} digits — federal bands should have 8 or 9 digits. Are you sure no digits are missing?`);
          setBandWarning(lines.join('\n\n'));
          return;
        }
      } else if (!NewAdultIsNew) {
        // Observed band: allow digits, dashes, and ? for unknown digits
        if (!/^[\d\-?]+$/.test(Code)) {
          setNewBandError('Use digits, a dash, or ? for any digit you can\'t read.');
          return;
        }
        // If no ? present, look up the band and show its origin
        if (!Code.includes('?')) {
          setBandLookupPending(true);
          const found = await lookupBandLocation(Code.toUpperCase());
          setBandLookupPending(false);
          if (found) {
            setBandWarning(`Band ${Code.toUpperCase()} was originally assigned at ${locationString(found)}.`);
            return;
          }
        }
      }
    }
    commitAdultBand();
  }

  async function openPriorBandsInfo(nestlingId: string, label: string) {
    setPriorBandsInfoLabel(label);
    setPriorBandsInfoData(null);
    setPriorBandsInfoLoading(true);
    setPriorBandsInfoVisible(true);
    try {
      if (isOnline) {
        let q = supabase
          .from('bands')
          .select('band_type, band_color, band_code, nest_check_entries(nest_checks(check_date))')
          .eq('nestling_id', nestlingId);
        if (ExistingEntryId) q = q.neq('nest_check_entry_id', ExistingEntryId);
        const { data } = await q;
        setPriorBandsInfoData((data ?? []).map((B: any) => ({
          band_type:  B.band_type,
          band_color: B.band_color ?? null,
          band_code:  B.band_code,
          check_date: B.nest_check_entries?.nest_checks?.check_date ?? '',
        })));
      } else {
        setPriorBandsInfoData(
          await getLocalPriorBandDetails(nestlingId, ExistingEntryId ?? null)
        );
      }
    } catch {
      setPriorBandsInfoData([]);
    }
    setPriorBandsInfoLoading(false);
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
  async function performSave(fledgeCountOverride?: number): Promise<boolean> {
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
      fledged_count:      IsPM ? (fledgeCountOverride ?? FledgedCount) : 0,
      renesting_attempt:  IsPM && HasNest ? Renesting : false,
      nesting_attempt:      NestingAttempt,
      notes:              Notes.trim() || null,
      observed_male_age:  IsPM ? ObservedMaleAge : null,
      observed_female_age: IsPM ? ObservedFemaleAge : null,
      gourd_removed:      IsGourd ? GourdRemoved : false,
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

      // Write-through to Supabase immediately so that the next loadEntry read
      // doesn't race against the background sync and return a stale nesting_attempt.
      try {
        if (ExistingEntryId) {
          await supabase.from('nest_check_entries').update(EntryPayload).eq('id', ExistingEntryId);
        } else {
          await supabase.from('nest_check_entries').upsert({ id: EntryId, ...EntryPayload });
        }
      } catch {}
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
      if (SaveErr) { setErrorMessage(friendlyError(SaveErr, 'Failed to save entry.')); setSaving(false); return false; }

      // Nestlings
      const NewLabelToId = new Map<string, string>();
      const NestlingsToCreate = Nestlings.filter(N => N.id === null && N.bandsThisCheck.length > 0);
      if (NestlingsToCreate.length > 0) {
        const { data: Created, error: NestlingErr } = await supabase
          .from('nestlings')
          .insert(NestlingsToCreate.map(N => ({ compartment_id: CompartmentId, site_season_id: SeasonId, label: N.label })))
          .select('id, label');
        if (NestlingErr) { setErrorMessage(friendlyError(NestlingErr, 'Failed to save nestlings.')); setSaving(false); return false; }
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
        if (BandErr) { setErrorMessage(friendlyError(BandErr, 'Failed to save bands.')); setSaving(false); return false; }
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

  async function tagFutureEntriesAsNextAttempt(nextAttempt: number) {
    const FutureIds = AllPriorEntriesRef.current
      .filter(e => e.check_date > CheckDate)
      .map(e => e.id).filter(id => id !== '');
    if (FutureIds.length > 0) {
      try { await supabase.from('nest_check_entries').update({ nesting_attempt: nextAttempt }).in('id', FutureIds); } catch {}
      try { await setLocalEntriesNestingAttempt(FutureIds, nextAttempt); } catch {}
    }
  }

  async function handleRenestingToggle() {
    if (Renesting) {
      // Block if a later RA exists — user must remove it first to preserve ordering.
      const LaterRA = [...AllPriorEntriesRef.current]
        .filter(e => e.check_date > CheckDate && e.renesting_attempt)
        .sort((a, b) => a.check_date.localeCompare(b.check_date))[0];
      if (LaterRA) {
        Alert.alert(
          'Later Renesting Attempt Exists',
          `A renesting attempt is already recorded on ${formatDate(LaterRA.check_date)}. You must remove that one first before removing this one.`,
          [
            { text: 'Stay Here', style: 'cancel' },
            {
              text: `Go to ${formatDate(LaterRA.check_date)}`,
              onPress: () => navigation.push('NestCheckEntry', {
                CheckId:          LaterRA.nest_check_id,
                CheckDate:        LaterRA.check_date,
                SeasonId,
                SiteId,
                CompartmentId,
                CompartmentLabel: route.params.CompartmentLabel,
                UnitName:         route.params.UnitName,
                ExistingEntryId:  LaterRA.id,
              }),
            },
          ],
        );
        return;
      }

      // Unwind: reset all entries at this attempt level (and any higher ones from
      // subsequent RAs that were removed first) back to the previous attempt.
      // Clamp RevertFrom to at least 2 — if nesting_attempt was corrupted to 1
      // while renesting_attempt is true, reverting 1→0 would zero out every entry.
      MarkDirty();
      const RevertFrom = Math.max(NestingAttempt, 2);  // e.g. 3, or 2 if corrupted
      const RevertTo   = RevertFrom - 1;               // e.g. 2, or 1 if corrupted
      setRenesting(false);
      setNestingAttempt(RevertTo);
      const YearStr = CheckDate.substring(0, 4);
      try {
        const { data: SeasonChecks } = await supabase
          .from('nest_checks').select('id')
          .eq('site_id', SiteId)
          .gte('check_date', `${YearStr}-01-01`)
          .lte('check_date', `${YearStr}-12-31`);
        if (SeasonChecks && SeasonChecks.length > 0) {
          await supabase.from('nest_check_entries')
            .update({ nesting_attempt: RevertTo })
            .in('nest_check_id', SeasonChecks.map(c => c.id))
            .eq('compartment_id', CompartmentId)
            .gte('nesting_attempt', RevertFrom);
        }
      } catch {}
      try { await resetLocalNestingAttemptsForCompartment(CompartmentId, SiteId, parseInt(YearStr, 10), RevertFrom, RevertTo); } catch {}
      return;
    }

    MarkDirty();

    const CurrentAttempt = NestingAttempt;       // attempt this check is currently in
    const NextAttempt    = CurrentAttempt + 1;   // the new attempt being started

    // Only look at entries within the CURRENT attempt — not earlier attempts
    const Prior = [...AllPriorEntriesRef.current]
      .filter(e => e.check_date < CheckDate && e.nesting_attempt === CurrentAttempt)
      .sort((a, b) => a.check_date.localeCompare(b.check_date));
    setRenesting(true);
    if (Prior.length === 0) { await tagFutureEntriesAsNextAttempt(NextAttempt); setNestingAttempt(NextAttempt); return; }

    // Use net eggs (deducting discards) so a check where all eggs were discarded
    // is correctly treated as a true trough, not as eggs still present
    const NetEggs = (e: typeof Prior[0]) => Math.max(0, e.egg_count - e.discarded_eggs);

    // Find peak: last occurrence of the maximum net egg count within current attempt
    const MaxNetEggs = Math.max(...Prior.map(NetEggs));
    let PeakIdx = -1;
    for (let i = Prior.length - 1; i >= 0; i--) {
      if (NetEggs(Prior[i]) === MaxNetEggs) { PeakIdx = i; break; }
    }
    const DeclineZone = Prior.slice(PeakIdx + 1);
    if (DeclineZone.length === 0) {
      await tagFutureEntriesAsNextAttempt(NextAttempt);
      setNestingAttempt(NextAttempt);
      Alert.alert(
        'Renesting Attempt',
        `This check marks the start of Attempt ${NextAttempt}. Subsequent checks for this compartment have been updated. Save this record to complete the change.`,
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
      await tagFutureEntriesAsNextAttempt(NextAttempt);
      setNestingAttempt(NextAttempt);
      const WasUnchecked = DeclineZone.some(e => IsUnchecked(e) && e.young_count === 0);
      Alert.alert(
        'Renesting Attempt',
        WasUnchecked
          ? `The nest was not inspected at the prior check(s), so the exact end of Attempt ${CurrentAttempt} is unknown. This check marks the start of Attempt ${NextAttempt}. Subsequent checks for this compartment have been updated. Save this record to complete the change.`
          : `The prior clutch appears to have hatched successfully. This check marks the start of Attempt ${NextAttempt}. Subsequent checks for this compartment have been updated. Save this record to complete the change.`,
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
    const NextAttempt = NestingAttempt + 1;
    if (!SelectedSplitDate) { setNestingAttempt(NextAttempt); setRenestingDialogVisible(false); return; }
    const SelCandidate = RenestingCandidates.find(c => c.check_date === SelectedSplitDate);
    const TroughNet = SelCandidate ? Math.max(0, SelCandidate.egg_count - SelCandidate.discarded_eggs) : 0;
    // If the trough was truly empty (all eggs discarded), it belongs to the current attempt.
    // Only entries strictly AFTER the trough date start the next attempt.
    // If the trough had remaining eggs, those may be new RA eggs, so include it in the next attempt.
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
      try { await supabase.from('nest_check_entries').update({ nesting_attempt: NextAttempt }).in('id', AllIds); } catch {}
      try { await setLocalEntriesNestingAttempt(AllIds, NextAttempt); } catch {}
    }
    setNestingAttempt(NextAttempt);
    setRenestingDialogVisible(false);
  }

  function handleRenestingCancel() {
    setRenesting(false);
    // NestingAttempt is unchanged here — dialog path doesn't mutate it
    setRenestingCandidates([]);
    setSelectedSplitDate(null);
    setRenestingDialogVisible(false);
  }

  function checkFledgeUnaccounted(): number {
    if (!IsPM || !PrevEntry || PrevEntry.nesting_attempt !== NestingAttempt) return 0;
    const PrevNetYoung = Math.max(0, PrevEntry.young_count - PrevEntry.dead_young_count);
    if (PrevNetYoung <= 0) return 0;
    const Reduction = PrevNetYoung - YoungCount;
    if (Reduction <= 0) return 0;
    const Age = CalculatedNestlingAge ?? (YoungCount > 0 && !IsHatchingDay ? NestlingAgeDays : null);
    if (Age === null || Age < 26) return 0;
    const Accounted = FledgedCount + (HasDeadYoung ? DeadYoungCount : 0);
    const Unaccounted = Reduction - Accounted;
    return Unaccounted > 0 ? Reduction : 0;
  }

  async function handleSave() {
    const U = checkFledgeUnaccounted();
    if (U > 0) {
      FledgeSaveAndNextRef.current = false;
      setFledgePromptCount(U);
      setFledgePromptVisible(true);
      return;
    }
    if (await performSave()) navigation.goBack();
  }

  async function navigateAfterSave() {
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

  async function handleFledgeYes() {
    const Count = FledgePromptCount;
    setFledgedCount(Count);
    setFledgePromptVisible(false);
    if (FledgeSaveAndNextRef.current) {
      if (await performSave(Count)) navigateAfterSave();
    } else {
      if (await performSave(Count)) navigation.goBack();
    }
  }

  async function handleFledgeNo() {
    setFledgePromptVisible(false);
    if (FledgeSaveAndNextRef.current) {
      if (await performSave()) navigateAfterSave();
    } else {
      if (await performSave()) navigation.goBack();
    }
  }

  async function handleSaveAndNext() {
    const U = checkFledgeUnaccounted();
    if (U > 0) {
      FledgeSaveAndNextRef.current = true;
      setFledgePromptCount(U);
      setFledgePromptVisible(true);
      return;
    }
    if (await performSave()) navigateAfterSave();
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
      const RevertFrom = NestingAttempt;
      const RevertTo   = NestingAttempt - 1;
      const YearStr = CheckDate.substring(0, 4);
      try {
        const { data: SeasonChecks } = await supabase
          .from('nest_checks').select('id')
          .eq('site_id', SiteId)
          .gte('check_date', `${YearStr}-01-01`)
          .lte('check_date', `${YearStr}-12-31`);
        if (SeasonChecks && SeasonChecks.length > 0) {
          await supabase.from('nest_check_entries')
            .update({ nesting_attempt: RevertTo })
            .in('nest_check_id', SeasonChecks.map(c => c.id))
            .eq('compartment_id', CompartmentId)
            .gte('nesting_attempt', RevertFrom);
        }
      } catch {}
      try { await resetLocalNestingAttemptsForCompartment(CompartmentId, SiteId, parseInt(YearStr, 10), RevertFrom, RevertTo); } catch {}
    }
    try { await deleteLocalEntry(ExistingEntryId); } catch {}
    const { error } = await supabase.from('nest_check_entries').delete().eq('id', ExistingEntryId);
    setDeleting(false);
    if (error) { setErrorMessage(friendlyError(error, 'Failed to delete entry.')); return; }
    setDeleteVisible(false);
    ClearDirty();
    navigation.goBack();
  }

  if (InitLoading) {
    return <View style={styles.Loading}><Text variant="bodyMedium">Loading entry…</Text></View>;
  }

  const PrevSummary = PrevEntry
    ? PrevEntry.is_empty_cavity ? 'Empty'
      : !PrevEntry.has_nest ? null
      : PrevEntry.species === 'PM'
        ? `PM · ${PrevEntry.egg_count}E${PrevEntry.discarded_eggs > 0 ? '/D' : ''} · ${PrevEntry.young_count}Y`
        : `${SpeciesLabel[PrevEntry.species] ?? PrevEntry.species} nest`
    : null;

  const DeadAdultLabel = [DeadAdultMale && 'M', DeadAdultFemale && 'F'].filter(Boolean).join(' + ');

  // Keep refs pointing at the latest handlers so Portal dialogs never call stale closures.
  ConfirmNestlingBandRef.current = handleConfirmNestlingBand;
  ConfirmAdultBandRef.current    = handleConfirmAdultBand;

  return (
    <>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
      >
      <ScrollView ref={ScrollViewRef} contentContainerStyle={styles.Container} keyboardShouldPersistTaps="handled">

        {/* ── Current check date ──────────────────────────────────── */}
        <Text style={styles.CheckDateBanner}>Check: {formatDate(CheckDate)}{NestingAttempt > 1 ? `  ·  Attempt ${NestingAttempt}` : ''}</Text>

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
            {/* First egg and Proj. hatch share one line */}
            {(FirstEggRange || (ProjectedHatchRange && !ActualHatchDate)) && (() => {
              const parts: string[] = [];
              if (FirstEggRange)
                parts.push(`First egg: ${FirstEggRange.min === FirstEggRange.max ? formatDate(FirstEggRange.min) : `${formatDate(FirstEggRange.min)}–${formatDate(FirstEggRange.max)}`}`);
              if (ProjectedHatchRange && !ActualHatchDate)
                parts.push(`Proj. hatch: ${ProjectedHatchRange.min === ProjectedHatchRange.max ? formatDate(ProjectedHatchRange.min) : `${formatDate(ProjectedHatchRange.min)}–${formatDate(ProjectedHatchRange.max)}`}`);
              return <Text style={styles.DateStat}>{parts.join('  ·  ')}</Text>;
            })()}
            {ActualHatchDate && (
              <Text style={styles.DateStat}>Actual hatch: {formatDate(ActualHatchDate)}</Text>
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

        {/* ── Empty cavity / Adult present (PM only, one row) ─────── */}
        {IsPM && (
          <View style={styles.PMStatusRow}>
            <Checkbox.Item
              label={L('Empty', 'X')}
              status={IsEmpty ? 'checked' : 'unchecked'}
              onPress={() => {
                MarkDirty();
                const Next = !IsEmpty;
                setIsEmpty(Next);
                if (Next) { setEggCount(0); setYoungCount(0); setHasNestOnly(false); setAdultPresent(false); }
              }}
              mode="android"
              style={[styles.CheckboxItem, styles.PMStatusItem]}
            />
            <Checkbox.Item
              label={L('Adult present (no check)', 'A')}
              status={AdultPresent ? 'checked' : 'unchecked'}
              onPress={() => {
                MarkDirty();
                const Next = !AdultPresent;
                setAdultPresent(Next);
                if (Next) { setIsEmpty(false); setHasNestOnly(false); }
              }}
              mode="android"
              style={[styles.CheckboxItem, styles.PMStatusItem]}
            />
          </View>
        )}

        {/* ── Purple Martin form ───────────────────────────────────── */}
        {!IsEmpty && !AdultPresent && IsPM && (
          <>
            <Checkbox.Item
              label={L('Nest (no eggs)', 'N')}
              status={HasNestOnly ? 'checked' : 'unchecked'}
              disabled={EggCount > 0 || YoungCount > 0}
              onPress={() => { MarkDirty(); const N = !HasNestOnly; setHasNestOnly(N); if (N) setIsEmpty(false); }}
              mode="android"
              position="trailing"
              style={[styles.CheckboxItem, { alignSelf: 'flex-start' }]}
            />

            <View style={styles.CountersRow}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Counter
                  label={CompactMode ? 'E' : <><Text style={{ fontWeight: '700' }}>Eggs</Text><Text> (incl. discards)</Text></>} value={EggCount}
                  onChange={(N) => { MarkDirty(); setEggCount(N); if (N > 0) { setIsEmpty(false); setHasNestOnly(false); } }}
                  prevValue={PrevEntry ? Math.max(0, PrevEntry.egg_count - PrevEntry.discarded_eggs) : undefined}
                />
                {EggCount > 0 && (
                  <Counter label={L('Discards', 'ED')} value={DiscardedEggs} onChange={(N) => { MarkDirty(); setDiscardedEggs(N); }} horizontal />
                )}
              </View>
              <View style={styles.ColumnDivider} />
              <View style={{ flex: 1, paddingLeft: 8 }}>
                <Counter
                  label={CompactMode ? 'Y' : <Text style={{ fontWeight: '700' }}>Young</Text>} value={YoungCount}
                  onChange={(N) => { MarkDirty(); setYoungCount(N); if (N > 0) { setIsEmpty(false); setHasNestOnly(false); } }}
                  prevValue={PrevEntry ? Math.max(0, PrevEntry.young_count - PrevEntry.dead_young_count) : undefined}
                />
                {YoungCount > 0 && (
                  <>
                    {CalculatedNestlingAge !== null ? (
                      <View style={styles.AgeRow}>
                        <Text style={styles.CalcAge}>Age: {CalculatedNestlingAge} days</Text>
                        <IconButton
                          icon="information"
                          size={18}
                          iconColor="#1565c0"
                          onPress={() => setAgeInfoVisible(true)}
                          style={{ margin: 0 }}
                        />
                      </View>
                    ) : (
                      <>
                        <View style={[IsHatchingDay && { opacity: 0.4 }]}>
                          <Counter label={L('Age', 'Age')} value={NestlingAgeDays} onChange={(N) => { MarkDirty(); setNestlingAgeDays(N); if (N > 0) setIsHatchingDay(false); }} horizontal />
                        </View>
                        <Checkbox.Item
                          label={L('Hatch Day', 'HD')}
                          status={IsHatchingDay ? 'checked' : 'unchecked'}
                          onPress={() => { MarkDirty(); const Next = !IsHatchingDay; setIsHatchingDay(Next); if (Next) setNestlingAgeDays(0); }}
                          mode="android"
                          style={styles.CheckboxItem}
                        />
                      </>
                    )}
                    <Checkbox.Item
                      label={L('Dead young', 'DY')}
                      status={HasDeadYoung ? 'checked' : 'unchecked'}
                      onPress={() => { MarkDirty(); setHasDeadYoung(!HasDeadYoung); }}
                      mode="android"
                      style={styles.CheckboxItem}
                    />
                    {HasDeadYoung && (
                      <Counter label={L('# dead', 'DY#')} value={DeadYoungCount} onChange={(N) => { MarkDirty(); setDeadYoungCount(N); }} horizontal />
                    )}
                  </>
                )}
              </View>
            </View>

            {HasNest && (
              <Checkbox.Item
                label={L('Renesting attempt', 'RA')}
                status={Renesting ? 'checked' : 'unchecked'}
                onPress={handleRenestingToggle}
                mode="android"
                style={styles.CheckboxItem}
              />
            )}
          </>
        )}

        {/* ── Fledge counter — visible whenever prior young exist and nestlings are old enough ── */}
        {IsPM && !AdultPresent && (PriorYoungSeen || YoungCount > 0) && (() => {
          const AgeForFledge = CalculatedNestlingAge ?? (YoungCount > 0 && !IsHatchingDay ? NestlingAgeDays : null);
          if (AgeForFledge !== null && AgeForFledge < 20) return null;
          return (
            <>
              <Divider style={styles.Divider} />
              <Counter label={L('Fledged', 'F')} value={FledgedCount} onChange={(N) => { MarkDirty(); setFledgedCount(N); }} horizontal />
            </>
          );
        })()}

        {/* ── Nest management (shared) ─────────────────────────────── */}
        {HasNest && (
          <>
            {(SpeciesVal === 'HS' || SpeciesVal === 'ST') && (
              <Checkbox.Item
                label={L('Nest discarded', 'ND')}
                status={NestDiscarded ? 'checked' : 'unchecked'}
                onPress={() => { MarkDirty(); setNestDiscarded(!NestDiscarded); }}
                mode="android"
                style={styles.CheckboxItem}
              />
            )}
            {IsPM && (
              <Checkbox.Item
                label={L('Nest replaced', 'NR')}
                status={NestReplaced ? 'checked' : 'unchecked'}
                onPress={() => { MarkDirty(); setNestReplaced(!NestReplaced); }}
                mode="android"
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
                <TouchableRipple onPress={() => setAgeConfirmInfoVisible(true)} borderless style={{ padding: 2, borderRadius: 12 }}>
                  <Icon
                    source={AgeStatus === 'complete' ? 'check-circle' : 'help-circle-outline'}
                    size={16}
                    color={AgeStatus === 'complete' ? '#22c55e' : AgeStatus === 'partial' ? '#f59e0b' : '#9e9e9e'}
                  />
                </TouchableRipple>
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
        {BandingEnabled && (() => {
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
                        {N.totalPriorBands > 0 && N.id && (
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={styles.NestlingPrior}>
                              {N.totalPriorBands} prior band{N.totalPriorBands !== 1 ? 's' : ''}
                            </Text>
                            <IconButton
                              icon="information-outline"
                              size={15}
                              iconColor="#1565c0"
                              style={{ margin: 0, marginLeft: -2 }}
                              onPress={() => openPriorBandsInfo(N.id!, N.label)}
                            />
                          </View>
                        )}
                      </View>
                      {[...N.bandsThisCheck].sort((a, b) => a.band_type === 'federal' ? -1 : b.band_type === 'federal' ? 1 : 0).map((B, BIdx) => (
                        <View key={BIdx} style={styles.BandRow}>
                          <Text style={styles.BandLabel}>
                            {B.band_type === 'federal' ? 'Federal ' : (B.band_color ? `${B.band_color} ` : 'Color ')}
                            {B.band_code}
                          </Text>
                          <IconButton
                            icon="pencil" size={16}
                            onPress={() => openEditNestlingBand(NIdx, BIdx)}
                            style={styles.BandDeleteBtn}
                          />
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
                        onPress={() => guardBandAction(() => openAddNestlingBand(NIdx))}
                      >
                        Add band to {N.label}
                      </Button>
                    </View>
                  ))}
                  <Button
                    mode="outlined" compact icon="plus"
                    style={styles.AddBandBtn}
                    disabled={Nestlings.length >= YoungCount}
                    onPress={() => guardBandAction(() => {
                      MarkDirty();
                      const NewLabel = `Nestling ${Nestlings.length + 1}`;
                      setNestlings(Ns => [...Ns, { id: null, label: NewLabel, bandsThisCheck: [], totalPriorBands: 0 }]);
                      openAddNestlingBand(Nestlings.length);
                    })}
                  >
                    Band a nestling{YoungCount > 0 ? ` (${YoungCount - Nestlings.length} remaining)` : ''}
                  </Button>

                  {/* Adults */}
                  <Text style={[styles.BandSubheader, styles.BandSubheaderSpaced]}>Adults</Text>
                  {(() => {
                    const groupOrder: string[] = [];
                    const groupMap = new Map<string, { band: AdultBand; idx: number }[]>();
                    AdultBands.forEach((B, Idx) => {
                      if (!groupMap.has(B.group_id)) {
                        groupOrder.push(B.group_id);
                        groupMap.set(B.group_id, []);
                      }
                      groupMap.get(B.group_id)!.push({ band: B, idx: Idx });
                    });
                    return groupOrder.map(gid => {
                      const entries = groupMap.get(gid)!;
                      const first = entries[0].band;
                      return (
                        <View key={gid} style={styles.AdultBandGroup}>
                          <View style={styles.AdultBandGroupHeader}>
                            <Text style={styles.AdultBandGroupLabel}>
                              {first.bird_type === 'adult_male' ? 'Adult ♂' : 'Adult ♀'}
                              {' · '}{first.is_new_banding ? 'New' : 'Obs'}
                            </Text>
                            <IconButton
                              icon="close" size={16}
                              onPress={() => { MarkDirty(); setAdultBands(Ab => Ab.filter(B => B.group_id !== gid)); }}
                              style={styles.BandDeleteBtn}
                            />
                          </View>
                          {[...entries].sort((a, b) => a.band.band_type === 'federal' ? -1 : b.band.band_type === 'federal' ? 1 : 0).map(({ band: B, idx: Idx }) => (
                            <View key={Idx} style={styles.AdultBandRow}>
                              <Text style={styles.AdultBandRowLabel}>
                                {B.band_type === 'federal' ? 'Federal ' : (B.band_color ? `${B.band_color} ` : 'Color ')}
                                {B.band_code}
                              </Text>
                              <IconButton
                                icon="pencil" size={16}
                                onPress={() => openEditAdultBand(Idx)}
                                style={styles.BandDeleteBtn}
                              />
                              <IconButton
                                icon="close" size={16}
                                onPress={() => { MarkDirty(); setAdultBands(Ab => Ab.filter((_, I) => I !== Idx)); }}
                                style={styles.BandDeleteBtn}
                              />
                            </View>
                          ))}
                          <Button
                            mode="text" compact icon="plus"
                            style={styles.AddNestlingBandBtn}
                            labelStyle={styles.AddNestlingBandLabel}
                            onPress={() => guardBandAction(() => {
                              setPendingAdultGroupId(gid);
                              setNewAdultBirdType(first.bird_type);
                              setNewAdultIsNew(first.is_new_banding);
                              setNewBandType('color');
                              setNewBandColor('');
                              setNewBandCode('');
                              setNewBandError('');
                              setEditAdultBandIdx(null);
                              setAddAdultBandVisible(true);
                            })}
                          >
                            Add another band to this bird
                          </Button>
                        </View>
                      );
                    });
                  })()}
                  <Button
                    mode="outlined" compact icon="plus"
                    style={styles.AddBandBtn}
                    onPress={() => guardBandAction(() => {
                      setPendingAdultGroupId(makeId());
                      setNewAdultBirdType('adult_male');
                      setNewAdultIsNew(true);
                      setNewBandType('federal');
                      setNewBandColor('');
                      setNewBandCode('');
                      setNewBandError('');
                      setBandWarning(null);
                      setEditAdultBandIdx(null);
                      setAddAdultBandVisible(true);
                    })}
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
              mode="android"
              style={styles.CheckboxItem}
            />
            <Checkbox.Item
              label="Dead female"
              status={DeadAdultFemale ? 'checked' : 'unchecked'}
              onPress={() => { MarkDirty(); setDeadAdultFemale(!DeadAdultFemale); }}
              mode="android"
              style={styles.CheckboxItem}
            />
          </View>
        )}

        {/* ── Gourd Removed (gourds only) ─────────────────────────── */}
        {IsGourd && (
          <Checkbox.Item
            label="Gourd removed"
            status={GourdRemoved ? 'checked' : 'unchecked'}
            onPress={() => { MarkDirty(); setGourdRemoved(!GourdRemoved); }}
            mode="android"
            style={styles.CheckboxItem}
          />
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
            maxLength={500}
            style={styles.NotesInput}
            onFocus={() => {
              const sub = Keyboard.addListener('keyboardDidShow', () => {
                ScrollViewRef.current?.scrollToEnd({ animated: true });
                sub.remove();
              });
            }}
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
      </KeyboardAvoidingView>

      <Portal>
        {/* ── Add Nestling Band ────────────────────────────────────── */}
        <Dialog
          visible={AddNestlingBandVisible}
          onDismiss={handleCancelNestlingBand}
          style={BandKeyboardHeight > 0 ? { marginBottom: BandKeyboardHeight } : undefined}
        >
          <Dialog.Title>
            {AddNestlingBandIdx !== null && Nestlings[AddNestlingBandIdx]
              ? `${EditNestlingBandIdx !== null ? 'Edit' : 'Add'} band: ${Nestlings[AddNestlingBandIdx].label}`
              : 'Add Nestling Band'}
          </Dialog.Title>
          <Dialog.ScrollArea style={BandKeyboardHeight > 0
            ? { maxHeight: Math.max(120, ScreenHeight - BandKeyboardHeight - 200) }
            : styles.BandDialogScroll}
          >
            <ScrollView ref={NestlingBandScrollRef} keyboardShouldPersistTaps="handled">
              <Text style={styles.BandFormLabel}>Band type</Text>
              <RadioButton.Group value={NewBandType} onValueChange={v => setNewBandType(v as 'federal' | 'color')}>
                <RadioButton.Item label="Federal (USFWS silver)" value="federal" style={styles.RadioItem} />
                <RadioButton.Item label="Color band"             value="color"   style={styles.RadioItem} />
              </RadioButton.Group>
              {EditNestlingBandIdx === null && (() => {
                const prev = NewBandType === 'federal' ? LastFederalCode : LastColorCode;
                if (!prev) return null;
                return (
                  <Button
                    mode="outlined" compact
                    style={styles.IncrementBtn}
                    onPress={() => {
                      if (NewBandType === 'color') setNewBandColor(LastColorBandColor ?? '');
                      setNewBandCode(incrementBandCode(prev));
                    }}
                  >
                    Increment from previous ({prev})
                  </Button>
                );
              })()}
              {NewBandType === 'color' && (
                <TextInput
                  label="Band color"
                  value={NewBandColor}
                  onChangeText={setNewBandColor}
                  placeholder="e.g. Red, Blue, Green"
                  maxLength={30}
                  style={styles.BandInput}
                  onFocus={() => setTimeout(() => NestlingBandScrollRef.current?.scrollToEnd({ animated: true }), 150)}
                />
              )}
              <TextInput
                label={NewBandType === 'federal' ? 'Band number (e.g. 2841-74209)' : 'Band code (e.g. TX 403)'}
                value={NewBandCode}
                onChangeText={setNewBandCode}
                autoCapitalize="characters"
                maxLength={20}
                style={styles.BandInput}
                onFocus={() => setTimeout(() => NestlingBandScrollRef.current?.scrollToEnd({ animated: true }), 150)}
              />
              {NewBandError ? <HelperText type="error" visible>{NewBandError}</HelperText> : null}
              {BandWarning && AddNestlingBandVisible
                ? <Text style={styles.BandWarningText}>{BandWarning}</Text>
                : null}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => { setBandWarning(null); handleCancelNestlingBand(); }}>
              {BandWarning && AddNestlingBandVisible ? 'Go back' : 'Cancel'}
            </Button>
            {BandWarning && AddNestlingBandVisible
              ? <Button onPress={() => { setBandWarning(null); commitNestlingBand(); }}>Add anyway</Button>
              : <Button onPress={() => ConfirmNestlingBandRef.current()} loading={BandLookupPending} disabled={BandLookupPending}>{EditNestlingBandIdx !== null ? 'Save' : 'Add'}</Button>
            }
          </Dialog.Actions>
        </Dialog>

        {/* ── Add / Edit Adult Band ────────────────────────────────── */}
        <Dialog
          visible={AddAdultBandVisible}
          onDismiss={() => { setEditAdultBandIdx(null); setPendingAdultGroupId(null); setAddAdultBandVisible(false); }}
          style={BandKeyboardHeight > 0 ? { marginBottom: BandKeyboardHeight } : undefined}
        >
          <Dialog.Title>{EditAdultBandIdx !== null ? 'Edit Adult Band' : 'Add Adult Band'}</Dialog.Title>
          <Dialog.ScrollArea style={BandKeyboardHeight > 0
            ? { maxHeight: Math.max(120, ScreenHeight - BandKeyboardHeight - 200) }
            : styles.BandDialogScroll}
          >
            <ScrollView ref={AdultBandScrollRef} keyboardShouldPersistTaps="handled">
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
              {EditAdultBandIdx === null && (() => {
                const prev = NewBandType === 'federal' ? LastFederalCode : LastColorCode;
                if (!prev) return null;
                return (
                  <Button
                    mode="outlined" compact
                    style={styles.IncrementBtn}
                    onPress={() => {
                      if (NewBandType === 'color') setNewBandColor(LastColorBandColor ?? '');
                      setNewBandCode(incrementBandCode(prev));
                    }}
                  >
                    Increment from previous ({prev})
                  </Button>
                );
              })()}
              {NewBandType === 'color' && (
                <TextInput
                  label="Band color"
                  value={NewBandColor}
                  onChangeText={setNewBandColor}
                  placeholder="e.g. Red, Blue, Green"
                  maxLength={30}
                  style={styles.BandInput}
                  onFocus={() => setTimeout(() => AdultBandScrollRef.current?.scrollToEnd({ animated: true }), 150)}
                />
              )}
              <TextInput
                label={NewBandType === 'federal' ? 'Band number (e.g. 2841-74209)' : 'Band code (e.g. TX 403)'}
                value={NewBandCode}
                onChangeText={setNewBandCode}
                autoCapitalize="characters"
                maxLength={20}
                style={styles.BandInput}
                onFocus={() => setTimeout(() => AdultBandScrollRef.current?.scrollToEnd({ animated: true }), 150)}
              />
              {NewBandType === 'federal' && !NewAdultIsNew && (
                <HelperText type="info" visible>
                  Use ? for any digit you can't read — e.g. ?341? (unknown digits before/after) or ?3?5 (unknown in the middle)
                </HelperText>
              )}
              {NewBandError ? <HelperText type="error" visible>{NewBandError}</HelperText> : null}
              {BandWarning && AddAdultBandVisible
                ? <Text style={styles.BandWarningText}>{BandWarning}</Text>
                : null}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => { setBandWarning(null); setEditAdultBandIdx(null); setPendingAdultGroupId(null); setAddAdultBandVisible(false); }}>
              {BandWarning && AddAdultBandVisible ? 'Go back' : 'Cancel'}
            </Button>
            {BandWarning && AddAdultBandVisible
              ? <Button onPress={() => { setBandWarning(null); commitAdultBand(); }}>Add anyway</Button>
              : <Button onPress={() => ConfirmAdultBandRef.current()} loading={BandLookupPending} disabled={BandLookupPending}>{EditAdultBandIdx !== null ? 'Save' : 'Add'}</Button>
            }
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
                    }{' '}The new clutch began after that date. Only this entry and any later checks will be tagged as Attempt {NestingAttempt + 1}.
                  </Text>
                );
              }
              return (
                <Text>
                  Based on previous checks, the new clutch appears to have started around{' '}
                  {formatDate(C.check_date)}. Entries from that check through this one will
                  be tagged as Attempt {NestingAttempt + 1}.
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
                        }{' '}Only entries after that check will be tagged as Attempt {NestingAttempt + 1}.
                      </Text>
                    );
                  }
                  return (
                    <Text style={{ marginTop: 8, fontSize: 13, color: '#666' }}>
                      Entries from {formatDate(SelectedSplitDate)} through this check will be tagged as Attempt {NestingAttempt + 1}.
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

        {/* ── Prior bands info ────────────────────────────────────── */}
        <Dialog visible={PriorBandsInfoVisible} onDismiss={() => setPriorBandsInfoVisible(false)}>
          <Dialog.Title>Prior bands: {PriorBandsInfoLabel}</Dialog.Title>
          <Dialog.Content>
            {PriorBandsInfoLoading
              ? <Text>Loading…</Text>
              : PriorBandsInfoData && PriorBandsInfoData.length > 0
                ? [...PriorBandsInfoData].sort((a, b) => {
                    if (a.check_date !== b.check_date) return a.check_date.localeCompare(b.check_date);
                    return a.band_type === 'federal' ? -1 : b.band_type === 'federal' ? 1 : 0;
                  }).map((B, I) => (
                    <Text key={I} style={{ marginBottom: 4 }}>
                      {B.check_date ? `${formatDate(B.check_date)}: ` : ''}
                      {B.band_type === 'federal' ? 'Federal' : (B.band_color ?? 'Color')} {B.band_code}
                    </Text>
                  ))
                : <Text style={{ color: '#666' }}>No prior bands on record.</Text>
            }
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPriorBandsInfoVisible(false)}>Close</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={AbandonVisible} onDismiss={() => setAbandonVisible(false)}>
          <Dialog.Title>Discard changes?</Dialog.Title>
          <Dialog.Content>
            <Text>You have unsaved changes. Go back and discard them? You may have to scroll down to see the Save/Update button.</Text>
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

        {/* ── Age source info ─────────────────────────────────────── */}
        <Dialog visible={AgeInfoVisible} onDismiss={() => setAgeInfoVisible(false)}>
          <Dialog.Title>Age calculated</Dialog.Title>
          <Dialog.Content>
            <Text>
              Nestling age was recorded on the check from {AgeSourceDate ? formatDate(AgeSourceDate) : 'a previous check'} and has been calculated forward to this check date ({formatDate(CheckDate)}).
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAgeInfoVisible(false)}>OK</Button>
          </Dialog.Actions>
        </Dialog>

        {/* ── Fledge prompt ───────────────────────────────────────── */}
        <Dialog visible={FledgePromptVisible} onDismiss={() => setFledgePromptVisible(false)}>
          <Dialog.Title>Young old enough to fledge</Dialog.Title>
          <Dialog.Content>
            <Text>
              {FledgePromptCount} young disappeared since the last check and {FledgePromptCount === 1 ? 'was' : 'were'} old enough to fledge. Mark {FledgePromptCount === 1 ? 'it' : 'them'} as fledged?
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setFledgePromptVisible(false)}>Keep editing</Button>
            <Button onPress={handleFledgeNo}>No</Button>
            <Button onPress={handleFledgeYes}>Yes</Button>
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

        {/* ── Band permit acknowledgment ────────────────────────── */}
        <Dialog visible={BandPermitDialogVisible} dismissable={false}>
          <Dialog.Title>Bird Banding Notice</Dialog.Title>
          <Dialog.ScrollArea style={{ maxHeight: 380 }}>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 8 }}>
              <Text variant="bodySmall" style={{ lineHeight: 20, marginBottom: 16 }}>
                Bird banding must only be performed by properly licensed bird banders operating under a federal USGS permit.
                It is a violation of federal law to band birds without a permit.
                {'\n\n'}
                Do not use your own bands that are sold for pigeons or other non-native birds. These can harm or kill birds for which they are not properly sized.
                {'\n\n'}
                Contact the USGS Bird Banding Lab for more information.
                {'\n\n'}
                Permits are not required to report on observations of bands you encounter.
              </Text>
              <TouchableRipple onPress={() => setBandPermitChecked(v => !v)} style={{ paddingVertical: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Checkbox status={BandPermitChecked ? 'checked' : 'unchecked'} />
                  <Text variant="bodySmall" style={{ flex: 1 }}>
                    I have a permit or am working with a licensed bird bander on an authorized banding research project.
                  </Text>
                </View>
              </TouchableRipple>
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => { setBandPermitDialogVisible(false); PendingBandAction.current = null; }}>Cancel</Button>
            <Button disabled={!BandPermitChecked} onPress={confirmBandPermit}>Continue</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  Loading:           { flex: 1, justifyContent: 'center', alignItems: 'center' },
  Container:         { padding: 16, paddingBottom: 16 },
  CheckDateBanner:   { fontSize: 13, color: '#555', fontWeight: 'bold', textDecorationLine: 'underline', marginBottom: 2 },
  PrevBanner:        { color: '#888', fontStyle: 'italic', marginBottom: 4 },
  HatchBanner:       { color: '#444', fontWeight: '500', marginBottom: 4 },
  DateStats:         { marginBottom: 4 },
  DateStat:          { fontSize: 13, color: '#444', marginBottom: 2 },
  CalcAge:           { fontSize: 14, color: '#333', fontWeight: '500', marginVertical: 4 },
  SpeciesRow:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  SpeciesCurrent:    { fontWeight: '600', fontSize: 15 },
  SpeciesBtnContent: { flexDirection: 'row-reverse' },
  Divider:           { marginVertical: 6 },
  CountersRow:       { flexDirection: 'row', gap: 16, marginBottom: 4 },
  Counter:           { alignItems: 'center', flex: 1 },
  CounterH:         { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  CounterLabel:      { fontSize: 16, color: '#444', marginBottom: 2 },
  CounterLabelH:    { fontSize: 16, color: '#444', flex: 1 },
  CounterControls:   { flexDirection: 'row', alignItems: 'center' },
  StepBtn:           { marginHorizontal: 4 },
  CounterInput: {
    width: 36, fontSize: 20, fontWeight: '600', textAlign: 'center',
    borderWidth: 1.5, borderColor: '#888', borderRadius: 4,
    paddingHorizontal: 4, paddingVertical: 4, color: '#000',
  },
  PrevBtn:           { marginTop: 1, alignSelf: 'center' },
  PrevBtnH:         { alignSelf: 'center' },
  PrevBtnLabel:      { fontSize: 14, marginVertical: 2, marginHorizontal: 4 },
  CheckboxItem:      { paddingVertical: 0 },
  PMStatusRow:       { flexDirection: 'row' },
  PMStatusItem:      { flex: 1 },
  ColumnDivider:     { width: 1, backgroundColor: '#ddd', alignSelf: 'stretch' },
  DeadYoungRow:      { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  ExpandBtn:         { alignSelf: 'flex-start', marginTop: 4 },
  ExpandBtnContent:  { flexDirection: 'row-reverse' },
  ExpandRow:         { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: 0 },
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
  Actions:           { marginTop: 8, gap: 8 },
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
  AdultBandGroup:       { marginBottom: 8, paddingLeft: 4, borderLeftWidth: 2, borderLeftColor: '#9c27b0' },
  AdultBandGroupHeader: { flexDirection: 'row', alignItems: 'center' },
  AdultBandGroupLabel:  { fontWeight: '600', fontSize: 13, color: '#222', flex: 1 },
  AdultBandRow:         { flexDirection: 'row', alignItems: 'center', paddingLeft: 8, marginBottom: 2 },
  AdultBandRowLabel:    { flex: 1, fontSize: 13, color: '#333' },
  BandDialogScroll:     { maxHeight: 440 },
  BandFormLabel:        { fontWeight: '600', fontSize: 13, marginTop: 12, marginBottom: 2, paddingHorizontal: 4 },
  BandInput:            { marginTop: 8, marginBottom: 4 },
  IncrementBtn:         { alignSelf: 'flex-start', marginTop: 8 },
  BandWarningText:      { color: '#b45309', marginTop: 6, marginBottom: 2, fontSize: 13, paddingHorizontal: 4 },
  RadioItem:            { paddingVertical: 0 },
});
