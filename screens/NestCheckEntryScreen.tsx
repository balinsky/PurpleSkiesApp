import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, TextInput as RNTextInput, View } from 'react-native';
import {
  Button, Checkbox, Dialog, Divider, HelperText,
  IconButton, Portal, RadioButton, Text, TextInput,
} from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { AppStackParamList } from '../App';
import { useSettings } from '../contexts/SettingsContext';

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
  young_count: number;
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
  function L(full: string, compact: string) { return CompactMode ? compact : full; }

  // ── Species ──────────────────────────────────────────────────────────
  const [SpeciesVal, setSpeciesVal]           = useState('PM');
  const [SpeciesExpanded, setSpeciesExpanded] = useState(false);

  // ── Status ───────────────────────────────────────────────────────────
  const [IsEmpty, setIsEmpty]         = useState(false);
  const [HasNestOnly, setHasNestOnly] = useState(false); // nest w/ no eggs, or non-PM nest present

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

  // ── Nest management ───────────────────────────────────────────────────
  const [NestDiscarded, setNestDiscarded] = useState(false);
  const [NestReplaced, setNestReplaced]   = useState(false);

  // ── Adult bird ages ───────────────────────────────────────────────────
  const [MaleAge, setMaleAge]                     = useState<'SY' | 'ASY' | 'UNK' | null>(null);
  const [FemaleAge, setFemaleAge]                 = useState<'SY' | 'ASY' | 'UNK' | null>(null);
  const [AdultAgesExpanded, setAdultAgesExpanded] = useState(false);

  // ── Dead adult (expandable) ───────────────────────────────────────────
  const [DeadAdultExpanded, setDeadAdultExpanded] = useState(false);
  const [DeadAdultMale, setDeadAdultMale]         = useState(false);
  const [DeadAdultFemale, setDeadAdultFemale]     = useState(false);

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

  // ── Derived ───────────────────────────────────────────────────────────
  const IsPM    = SpeciesVal === 'PM';
  const HasNest = IsPM ? (!IsEmpty && (EggCount > 0 || YoungCount > 0 || HasNestOnly)) : true;

  // Compact toggle in header
  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <IconButton
          icon={CompactMode ? 'view-compact' : 'view-compact-outline'}
          size={22}
          onPress={toggleCompactMode}
          style={{ marginRight: 4 }}
        />
      ),
    });
  }, [CompactMode]);

  // Fetch season context: prev-entry banner + hatch-date for nestling age
  useEffect(() => {
    async function fetchSeasonContext() {
      const Year = CheckDate.substring(0, 4);
      const { data: SeasonChecks } = await supabase
        .from('nest_checks')
        .select('id, check_date')
        .eq('site_id', SiteId)
        .gte('check_date', `${Year}-01-01`)
        .lte('check_date', `${Year}-12-31`)
        .neq('id', CheckId)
        .order('check_date', { ascending: true });

      if (!SeasonChecks || SeasonChecks.length === 0) return;

      const { data: OtherEntries } = await supabase
        .from('nest_check_entries')
        .select('nest_check_id, species, is_empty_cavity, has_nest, egg_count, young_count, nestling_age_days')
        .in('nest_check_id', SeasonChecks.map(c => c.id))
        .eq('compartment_id', CompartmentId);

      if (!OtherEntries) return;

      setPriorEggsSeen(OtherEntries.some(e => (e.egg_count ?? 0) > 0));
      setPriorYoungSeen(OtherEntries.some(e => (e.young_count ?? 0) > 0));

      // Prev entry: most recent check strictly before the current date that has data for this compartment
      for (const Check of [...SeasonChecks].reverse().filter(c => c.check_date < CheckDate)) {
        const E = OtherEntries.find(e => e.nest_check_id === Check.id);
        if (E) { setPrevEntry({ ...E, check_date: Check.check_date }); break; }
      }

      // Entries with dates, sorted ascending — used for egg/hatch date calculations
      const EWD = OtherEntries
        .map(e => {
          const C = SeasonChecks.find(c => c.id === e.nest_check_id);
          return C ? { check_date: C.check_date, egg_count: e.egg_count ?? 0, young_count: e.young_count ?? 0, nestling_age_days: e.nestling_age_days } : null;
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .sort((a, b) => a.check_date.localeCompare(b.check_date));

      // First egg date range
      // latest possible = first-check-with-eggs − (N − 1) days
      // earliest possible = day after last check that showed 0 eggs
      const FirstWithEggs = EWD.find(e => e.egg_count > 0);
      if (FirstWithEggs) {
        const LastEmpty = [...EWD]
          .filter(e => e.egg_count === 0 && e.check_date < FirstWithEggs.check_date)
          .pop();
        const LatestFirst   = addDays(FirstWithEggs.check_date, -(FirstWithEggs.egg_count - 1));
        const EarliestFirst = LastEmpty ? addDays(LastEmpty.check_date, 1) : null;
        // Guard against contradictory data (EarliestFirst > LatestFirst)
        const MinFirst = (EarliestFirst && EarliestFirst <= LatestFirst) ? EarliestFirst : LatestFirst;
        setFirstEggRange({ min: MinFirst, max: LatestFirst });

        const MaxEggs = Math.max(...EWD.map(e => e.egg_count));
        setProjectedHatchRange({
          min: addDays(MinFirst,    MaxEggs - 1 + 15),
          max: addDays(LatestFirst, MaxEggs - 1 + 15),
        });
      }

      // Hatch date anchor: earliest check with a recorded nestling age
      for (const Check of SeasonChecks) {
        const E = OtherEntries.find(
          e => e.nest_check_id === Check.id &&
            (e.young_count ?? 0) > 0 &&
            (e.nestling_age_days ?? 0) > 0
        );
        if (E) {
          const [ay, am, ad] = Check.check_date.split('-').map(Number);
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
    supabase
      .from('nest_check_entries').select('*').eq('id', ExistingEntryId).single()
      .then(({ data: E }) => {
        if (!E) return;
        setSpeciesVal(E.species ?? 'PM');
        setIsEmpty(E.is_empty_cavity ?? false);
        setEggCount(E.egg_count ?? 0);
        setYoungCount(E.young_count ?? 0);
        setHasNestOnly(E.has_nest && E.egg_count === 0 && E.young_count === 0);
        setDiscardedEggs(E.discarded_eggs ?? 0);
        setIsHatchingDay(E.nestling_age_days === 0);
        setNestlingAgeDays(E.nestling_age_days ?? 0);
        setHasDeadYoung((E.dead_young_count ?? 0) > 0);
        setDeadYoungCount(E.dead_young_count ?? 0);
        setFledgedCount(E.fledged_count ?? 0);
        setRenesting(E.renesting_attempt ?? false);
        setNestDiscarded(E.nest_discarded ?? false);
        setNestReplaced(E.nest_replaced ?? false);
        setDeadAdultMale(E.dead_adult_male ?? false);
        setDeadAdultFemale(E.dead_adult_female ?? false);
        if (E.dead_adult_male || E.dead_adult_female) setDeadAdultExpanded(true);
        setNotes(E.notes ?? '');
        if (E.notes) setNotesExpanded(true);
        setInitLoading(false);
      });
  }, [ExistingEntryId]);

  // Load adult ages for this compartment/season
  useEffect(() => {
    supabase
      .from('nest_seasons')
      .select('male_age, female_age')
      .eq('compartment_id', CompartmentId)
      .eq('site_season_id', SeasonId)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        const M = data.male_age as 'SY' | 'ASY' | 'UNK' | null;
        const F = data.female_age as 'SY' | 'ASY' | 'UNK' | null;
        setMaleAge(M); setFemaleAge(F);
        if (M || F) setAdultAgesExpanded(true);
      });
  }, []);

  function handleSpeciesChange(Val: string) {
    setSpeciesVal(Val);
    setSpeciesExpanded(false);
    if (Val !== 'PM') {
      setEggCount(0); setYoungCount(0); setDiscardedEggs(0);
      setNestlingAgeDays(0); setIsHatchingDay(false); setHasDeadYoung(false); setDeadYoungCount(0);
      setFledgedCount(0); setRenesting(false);
      setNestReplaced(false);
      setIsEmpty(false); setHasNestOnly(false);
    }
    if (Val !== 'HS' && Val !== 'ST') {
      setNestDiscarded(false);
    }
  }

  // ── Save ───────────────────────────────────────────────────────────────
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

    const Payload = {
      nest_check_id:      CheckId,
      compartment_id:     CompartmentId,
      species:            SpeciesVal,
      is_empty_cavity:    IsEmpty,
      has_nest:           HasNest,
      nest_discarded:     HasNest && (SpeciesVal === 'HS' || SpeciesVal === 'ST') ? NestDiscarded : false,
      nest_replaced:      HasNest && IsPM ? NestReplaced : false,
      egg_count:          IsPM && !IsEmpty ? EggCount : 0,
      discarded_eggs:     IsPM && EggCount > 0 ? DiscardedEggs : 0,
      young_count:        IsPM && !IsEmpty ? YoungCount : 0,
      nestling_age_days:  IsPM && YoungCount > 0
        ? (CalculatedNestlingAge ?? (IsHatchingDay ? 0 : (NestlingAgeDays > 0 ? NestlingAgeDays : null)))
        : null,
      nestling_age_notes: null,
      dead_young_count:   IsPM && YoungCount > 0 && HasDeadYoung ? DeadYoungCount : 0,
      dead_adult_male:    DeadAdultMale,
      dead_adult_female:  DeadAdultFemale,
      fledged_count:      IsPM && HasNest ? FledgedCount : 0,
      renesting_attempt:  IsPM && HasNest ? Renesting : false,
      notes:              Notes.trim() || null,
    };

    let Err;
    if (ExistingEntryId) {
      ({ error: Err } = await supabase.from('nest_check_entries').update(Payload).eq('id', ExistingEntryId));
    } else {
      ({ error: Err } = await supabase.from('nest_check_entries').insert(Payload));
    }

    setSaving(false);
    if (Err) { setErrorMessage(Err.message); return false; }

    if (IsPM) {
      const { data: Existing, error: SelectErr } = await supabase
        .from('nest_seasons')
        .select('id')
        .eq('compartment_id', CompartmentId)
        .eq('site_season_id', SeasonId)
        .maybeSingle();

      let AgeErr;
      if (SelectErr) {
        AgeErr = SelectErr;
      } else if (Existing) {
        ({ error: AgeErr } = await supabase.from('nest_seasons')
          .update({ male_age: MaleAge, female_age: FemaleAge })
          .eq('id', Existing.id));
      } else {
        ({ error: AgeErr } = await supabase.from('nest_seasons')
          .insert({ compartment_id: CompartmentId, site_season_id: SeasonId, male_age: MaleAge, female_age: FemaleAge }));
      }

      if (AgeErr) { setErrorMessage(`Adult ages: ${AgeErr.message}`); return false; }
    }

    return true;
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
    setDeleting(true);
    const { error } = await supabase.from('nest_check_entries').delete().eq('id', ExistingEntryId);
    setDeleting(false);
    if (error) { setErrorMessage(error.message); return; }
    setDeleteVisible(false);
    navigation.goBack();
  }

  if (InitLoading) {
    return <View style={styles.Loading}><Text variant="bodyMedium">Loading entry…</Text></View>;
  }

  const PrevSummary = PrevEntry
    ? PrevEntry.is_empty_cavity ? 'Empty cavity'
      : !PrevEntry.has_nest ? 'No nest'
      : PrevEntry.species === 'PM'
        ? `PM · ${PrevEntry.egg_count}E · ${PrevEntry.young_count}Y`
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
          </Text>
        )}

        {/* ── Nestling age (auto-calculated from hatch date) ──────── */}
        {CalculatedNestlingAge !== null && (
          <Text style={styles.HatchBanner}>
            Nestling age: {CalculatedNestlingAge} days
          </Text>
        )}

        {/* ── Egg / hatch / fledge date projections ───────────────── */}
        {ActualHatchDate ? (
          <View style={styles.DateStats}>
            <Text style={styles.DateStat}>Hatched: {formatDate(ActualHatchDate)}</Text>
            {ProjectedFledgeDate && (
              <Text style={styles.DateStat}>Proj. fledge: {formatDate(ProjectedFledgeDate)}</Text>
            )}
          </View>
        ) : FirstEggRange ? (
          <View style={styles.DateStats}>
            <Text style={styles.DateStat}>
              First egg:{' '}
              {FirstEggRange.min === FirstEggRange.max
                ? formatDate(FirstEggRange.min)
                : `${formatDate(FirstEggRange.min)}–${formatDate(FirstEggRange.max)}`}
            </Text>
            {ProjectedHatchRange && (
              <Text style={styles.DateStat}>
                Proj. hatch:{' '}
                {ProjectedHatchRange.min === ProjectedHatchRange.max
                  ? formatDate(ProjectedHatchRange.min)
                  : `${formatDate(ProjectedHatchRange.min)}–${formatDate(ProjectedHatchRange.max)}`}
              </Text>
            )}
          </View>
        ) : null}

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
          <Checkbox.Item
            label={L('Empty cavity', 'X')}
            status={IsEmpty ? 'checked' : 'unchecked'}
            onPress={() => {
              const Next = !IsEmpty;
              setIsEmpty(Next);
              if (Next) { setEggCount(0); setYoungCount(0); setHasNestOnly(false); }
            }}
            style={styles.CheckboxItem}
          />
        )}

        {/* ── Purple Martin form ───────────────────────────────────── */}
        {!IsEmpty && IsPM && (
          <>
            {EggCount === 0 && YoungCount === 0 && (
              <Checkbox.Item
                label={L('Nest (no eggs)', 'N')}
                status={HasNestOnly ? 'checked' : 'unchecked'}
                onPress={() => { const N = !HasNestOnly; setHasNestOnly(N); if (N) setIsEmpty(false); }}
                style={styles.CheckboxItem}
              />
            )}

            <View style={styles.CountersRow}>
              <Counter
                label={L('Eggs', 'E')} value={EggCount}
                onChange={(N) => { setEggCount(N); if (N > 0) setIsEmpty(false); }}
                prevValue={PrevEntry?.egg_count}
              />
              <Counter
                label={L('Young', 'Y')} value={YoungCount}
                onChange={(N) => { setYoungCount(N); if (N > 0) setIsEmpty(false); }}
                prevValue={PrevEntry?.young_count}
              />
            </View>

            {EggCount > 0 && (
              <Counter label={L('Discarded eggs', 'ED')} value={DiscardedEggs} onChange={setDiscardedEggs} />
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
                      onPress={() => setIsHatchingDay(!IsHatchingDay)}
                      style={styles.CheckboxItem}
                    />
                    {!IsHatchingDay && (
                      <Counter label={L('Nestling age (days)', 'Age')} value={NestlingAgeDays} onChange={setNestlingAgeDays} />
                    )}
                  </>
                )}
                <View style={styles.DeadYoungRow}>
                  <Checkbox.Item
                    label={L('Dead young', 'DY')}
                    status={HasDeadYoung ? 'checked' : 'unchecked'}
                    onPress={() => setHasDeadYoung(!HasDeadYoung)}
                    style={styles.CheckboxItem}
                  />
                  {HasDeadYoung && (
                    <Counter label="" value={DeadYoungCount} onChange={setDeadYoungCount} />
                  )}
                </View>
              </>
            )}

            {HasNest && (
              <>
                <Divider style={styles.Divider} />
                <Counter label={L('Fledged', 'F')} value={FledgedCount} onChange={setFledgedCount} />
                <Checkbox.Item
                  label={L('Renesting attempt', 'RA')}
                  status={Renesting ? 'checked' : 'unchecked'}
                  onPress={() => setRenesting(!Renesting)}
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
                onPress={() => setNestDiscarded(!NestDiscarded)}
                style={styles.CheckboxItem}
              />
            )}
            {IsPM && (
              <Checkbox.Item
                label={L('Nest replaced', 'NR')}
                status={NestReplaced ? 'checked' : 'unchecked'}
                onPress={() => setNestReplaced(!NestReplaced)}
                style={styles.CheckboxItem}
              />
            )}
          </>
        )}

        <Divider style={styles.Divider} />

        {/* ── Adult bird ages (expandable, PM only) ───────────────── */}
        {IsPM && (
          <>
            <Button
              mode="text" compact
              icon={AdultAgesExpanded ? 'chevron-up' : 'chevron-down'}
              contentStyle={styles.ExpandBtnContent}
              onPress={() => setAdultAgesExpanded(!AdultAgesExpanded)}
              style={styles.ExpandBtn}
            >
              {L('Adult ages', 'Ages')}
              {(MaleAge || FemaleAge)
                ? ` · ${[MaleAge && `♂ ${MaleAge}`, FemaleAge && `♀ ${FemaleAge}`].filter(Boolean).join('  ')}`
                : ''}
            </Button>
            {AdultAgesExpanded && (
              <View style={styles.ExpandedSection}>
                {([['Male', MaleAge, setMaleAge], ['Female', FemaleAge, setFemaleAge]] as [string, typeof MaleAge, (v: typeof MaleAge) => void][]).map(([Sex, Val, Set]) => (
                  <View key={Sex} style={styles.AgeRow}>
                    <Text style={styles.AgeSexLabel}>{Sex}</Text>
                    <View style={styles.AgeChips}>
                      {(['SY', 'ASY', 'UNK'] as const).map(Age => (
                        <Button
                          key={Age} compact
                          mode={Val === Age ? 'contained' : 'outlined'}
                          onPress={() => Set(Val === Age ? null : Age)}
                          style={styles.AgeChip}
                          labelStyle={styles.AgeChipLabel}
                        >
                          {Age}
                        </Button>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>
        )}

        {/* ── Dead adult (expandable) ──────────────────────────────── */}
        <Button
          mode="text" compact
          icon={DeadAdultExpanded ? 'chevron-up' : 'chevron-down'}
          contentStyle={styles.ExpandBtnContent}
          onPress={() => setDeadAdultExpanded(!DeadAdultExpanded)}
          style={styles.ExpandBtn}
        >
          {L('Dead adult bird', 'DA')}{DeadAdultLabel ? ` · ${DeadAdultLabel}` : ''}
        </Button>
        {DeadAdultExpanded && (
          <View style={styles.ExpandedSection}>
            <Checkbox.Item
              label="Dead male"
              status={DeadAdultMale ? 'checked' : 'unchecked'}
              onPress={() => setDeadAdultMale(!DeadAdultMale)}
              style={styles.CheckboxItem}
            />
            <Checkbox.Item
              label="Dead female"
              status={DeadAdultFemale ? 'checked' : 'unchecked'}
              onPress={() => setDeadAdultFemale(!DeadAdultFemale)}
              style={styles.CheckboxItem}
            />
          </View>
        )}

        {/* ── Notes (expandable) ──────────────────────────────────── */}
        <Button
          mode="text" compact
          icon={NotesExpanded ? 'chevron-up' : 'chevron-down'}
          contentStyle={styles.ExpandBtnContent}
          onPress={() => setNotesExpanded(!NotesExpanded)}
          style={styles.ExpandBtn}
        >
          Notes{Notes.trim() ? ' · …' : ''}
        </Button>
        {NotesExpanded && (
          <TextInput
            value={Notes}
            onChangeText={setNotes}
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
  ExpandedSection:   { paddingLeft: 8 },
  NotesInput:        { marginTop: 8 },
  AgeRow:            { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  AgeSexLabel:       { width: 56, fontSize: 13, color: '#444' },
  AgeChips:          { flexDirection: 'row', gap: 6 },
  AgeChip:           { alignSelf: 'flex-start' },
  AgeChipLabel:      { fontSize: 12, marginHorizontal: 6, marginVertical: 2 },
  Actions:           { marginTop: 20, gap: 8 },
  SaveRow:           { flexDirection: 'row', gap: 12 },
  ActionBtn:         { flex: 1 },
  DeleteBtn:         { borderColor: 'red' },
});
