import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, SectionList, StyleSheet, View } from 'react-native';
import { Button, Card, Dialog, HelperText, IconButton, Portal, Text, TextInput } from 'react-native-paper';
import DateInput from '../components/DateInput';
import HeaderMenu from '../components/HeaderMenu';
import { useSiteRole } from '../lib/useSiteRole';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { friendlyError } from '../lib/errorUtils';
import { AppStackParamList } from '../App';
import { useSync } from '../contexts/SyncContext';
import { SpeciesLabel, buildEntrySummary } from '../lib/nestLogic';
import {
  cacheUnitsAndCompartments, getLocalUnitsWithCompartments,
  cacheEntries, getLocalEntriesForCheck,
  getLocalBandEntryIds, localEntryToJs,
  cacheNestSeasons, getLocalNestSeasons,
  upsertLocalEntry, makeId,
} from '../lib/localDb';

type PrevEntryData = {
  summary: string | null;
  species: string;
  is_empty_cavity: boolean;
  has_nest: boolean;
  nest_discarded: boolean;
  adult_present: boolean;
  egg_count: number;
  discarded_eggs: number;
  young_count: number;
  nestling_age_days: number | null;
  fledged_count: number;
  nesting_attempt: number;
  renesting_attempt: boolean;
};

type CompartmentRow = {
  id: string;
  cavity_label: string;
  sort_order: number | null;
  unit_id: string;
  unit_name: string;
  housing_type: string | null;
  entry_id: string | null;
  entry_summary: string | null;
  entry_has_nest: boolean;
  prev_summary: string | null;
  prev_entry: PrevEntryData | null;
  calculated_nestling_age: number | null;
};

type Section = {
  title: string;
  unit_id: string;
  data: CompartmentRow[];
};

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'NestCheckDetail'>;
  route: RouteProp<AppStackParamList, 'NestCheckDetail'>;
};



export default function NestCheckDetailScreen({ navigation, route }: Props) {
  const { CheckId, CheckDate, SiteId, SeasonId, Year } = route.params;
  const { syncNow, isOnline } = useSync();
  const UserRole  = useSiteRole(SiteId);
  const CanWrite  = UserRole !== null && UserRole !== 'viewer';
  const CanManage = UserRole === 'owner' || UserRole === 'manager';

  const [Sections, setSections] = useState<Section[]>([]);
  const [CollapsedUnits, setCollapsedUnits] = useState<Set<string>>(new Set());
  const [Loading, setLoading]   = useState(true);
  const [QuickSaving, setQuickSaving]     = useState<string | null>(null);
  const [MarkingAllEmpty, setMarkingAllEmpty] = useState(false);

  // ── Fledge prompt (triggered by quick-save when prior had young ≥ 26 days)
  const [FledgePromptVisible, setFledgePromptVisible] = useState(false);
  const [FledgePromptCount, setFledgePromptCount]     = useState(0);
  const [FledgePromptItem, setFledgePromptItem]       = useState<CompartmentRow | null>(null);
  const [FledgePromptType, setFledgePromptType]       = useState<'empty' | 'pm_nest'>('empty');

  // ── Edit date ──────────────────────────────────────────────────────
  const [EditDateVisible, setEditDateVisible]   = useState(false);
  const [EditDateValue, setEditDateValue]       = useState('');
  const [EditDateLoading, setEditDateLoading]   = useState(false);
  const [EditDateError, setEditDateError]       = useState('');

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderMenu
          navigation={navigation}
          onDelete={CanManage ? () => setDeleteVisible(true) : undefined}
          deleteLabel="Delete check"
        />
      ),
    });
  }, [navigation, CanManage]);

  // ── Delete check ───────────────────────────────────────────────────
  const [DeleteVisible, setDeleteVisible] = useState(false);
  const [Deleting, setDeleting]           = useState(false);
  const [DeleteError, setDeleteError]     = useState('');

  useFocusEffect(useCallback(() => { loadData(); }, [CheckId, SiteId]));

  async function loadData() {
    type UnitRow = { id: string; name: string; compartments: { id: string; cavity_label: string; sort_order: number | null; housing_type: string | null }[] };
    type EntryRow = { id: string; compartment_id: string; species: string; is_empty_cavity: boolean; has_nest: boolean; nest_discarded: boolean; adult_present: boolean; renesting_attempt: boolean; egg_count: number; discarded_eggs: number; young_count: number; nestling_age_days: number | null; fledged_count: number; gourd_removed: boolean };
    type SeasonRow = { compartment_id: string; male_age: string | null; female_age: string | null };

    function buildSections(
      Units: UnitRow[], Entries: EntryRow[], BandingSet: Set<string>,
      HatchDateMap: Map<string, string>, SeasonRows: SeasonRow[],
      PrevEntryMap: Map<string, PrevEntryData>,
    ) {
      function effectiveAge(compartmentId: string, stored: number | null): number | null {
        if (stored !== null) return stored;
        const HatchDate = HatchDateMap.get(compartmentId);
        if (!HatchDate) return null;
        const [hy, hm, hd] = HatchDate.split('-').map(Number);
        const [cy, cm, cd] = CheckDate.split('-').map(Number);
        const Days = Math.round(
          (new Date(cy, cm - 1, cd).getTime() - new Date(hy, hm - 1, hd).getTime()) / 86400000
        );
        return Days > 0 ? Days : null;
      }
      const AgeMap = new Map<string, SeasonRow>();
      SeasonRows.forEach((NS) => AgeMap.set(NS.compartment_id, NS));
      const EntryMap = new Map<string, EntryRow>();
      Entries.forEach((E) => EntryMap.set(E.compartment_id, E));

      setSections(Units.map((Unit) => ({
        title:   Unit.name,
        unit_id: Unit.id,
        data: Unit.compartments
          .slice()
          .sort((A, B) => {
            if (A.sort_order !== null && B.sort_order !== null) return A.sort_order - B.sort_order;
            if (A.sort_order !== null) return -1;
            if (B.sort_order !== null) return 1;
            return A.cavity_label.localeCompare(B.cavity_label);
          })
          .map((C) => {
            const Entry = EntryMap.get(C.id) ?? null;
            return {
              id:            C.id,
              cavity_label:  C.cavity_label,
              sort_order:    C.sort_order,
              unit_id:       Unit.id,
              unit_name:     Unit.name,
              housing_type:  (C as any).housing_type ?? null,
              entry_id:       Entry?.id ?? null,
              entry_has_nest: !!(Entry?.is_empty_cavity || Entry?.has_nest ||
                (Entry?.egg_count ?? 0) > 0 || (Entry?.young_count ?? 0) > 0 ||
                (Entry?.fledged_count ?? 0) > 0 || Entry?.nest_discarded ||
                Entry?.adult_present),
              entry_summary: Entry ? buildEntrySummary({
                ...Entry,
                nestling_age_days: effectiveAge(C.id, Entry.nestling_age_days),
                male_age:   AgeMap.get(C.id)?.male_age   ?? (Entry as any).observed_male_age   ?? null,
                female_age: AgeMap.get(C.id)?.female_age ?? (Entry as any).observed_female_age ?? null,
                has_banding: BandingSet.has(Entry.id),
              }) : null,
              prev_summary: (() => {
                const P = PrevEntryMap.get(C.id);
                if (!P) return null;
                // Always project to today's check date; fall back to stored age only if
                // no hatch anchor exists (effectiveAge returns null when passed null).
                return buildEntrySummary({
                  ...P,
                  nestling_age_days: effectiveAge(C.id, null) ?? P.nestling_age_days,
                });
              })(),
              prev_entry:             PrevEntryMap.get(C.id) ?? null,
              calculated_nestling_age: effectiveAge(C.id, null),
            };
          }),
      })));
      setLoading(false);
    }

    try {
      let { data: Units, error: UnitsError } = await supabase
        .from('housing_units')
        .select('id, name, compartments(id, cavity_label, sort_order, housing_type)')
        .eq('site_season_id', SeasonId)
        .order('name');
      if (UnitsError) throw UnitsError;
      // Fall back to legacy site-scoped housing for sites not yet migrated
      if (!Units || Units.length === 0) {
        const { data: Legacy, error: LegacyErr } = await supabase
          .from('housing_units')
          .select('id, name, compartments(id, cavity_label, sort_order, housing_type)')
          .eq('site_id', SiteId)
          .is('site_season_id', null)
          .order('name');
        if (LegacyErr) throw LegacyErr;
        Units = Legacy;
      }

      const { data: RemoteEntries, error: EntriesError } = await supabase
        .from('nest_check_entries')
        .select('id, compartment_id, species, is_empty_cavity, has_nest, nest_discarded, adult_present, renesting_attempt, egg_count, discarded_eggs, young_count, nestling_age_days, fledged_count, gourd_removed')
        .eq('nest_check_id', CheckId);
      if (EntriesError) throw EntriesError;

      // Overlay locally-pending entries so saves appear immediately before sync completes
      let Entries: any[] = RemoteEntries ?? [];
      try {
        const LocalPending = (await getLocalEntriesForCheck(CheckId))
          .filter(E => E.sync_status === 'pending')
          .map(localEntryToJs);
        if (LocalPending.length > 0) {
          const PendingByComp = new Map(LocalPending.map(E => [E.compartment_id, E]));
          Entries = [
            ...Entries.filter(E => !PendingByComp.has(E.compartment_id)),
            ...LocalPending,
          ];
        }
      } catch {}

      // Fire-and-forget cache to local DB (non-blocking on web)
      cacheUnitsAndCompartments(
        (Units ?? []).map(U => ({ id: U.id, name: U.name, site_id: SiteId, site_season_id: SeasonId })),
        (Units ?? []).flatMap(U =>
          ((U.compartments as any[]) ?? []).map((C: any) => ({
            id: C.id, housing_unit_id: U.id, cavity_label: C.cavity_label, sort_order: C.sort_order ?? null, site_season_id: SeasonId,
          }))
        ),
      ).catch(() => {});
      cacheEntries(Entries ?? []).catch(() => {});

      const BandingSet = new Set<string>();
      if (Entries && Entries.length > 0) {
        const { data: BandRows } = await supabase
          .from('bands')
          .select('nest_check_entry_id')
          .in('nest_check_entry_id', Entries.map(e => e.id));
        if (BandRows) BandRows.forEach(B => BandingSet.add(B.nest_check_entry_id));
      }

      // Build hatch-date map from prior checks so nestling age can be inferred when not stored
      const HatchDateMap = new Map<string, string>();
      const YearStr = CheckDate.substring(0, 4);
      const { data: PriorChecks } = await supabase
        .from('nest_checks')
        .select('id, check_date')
        .eq('site_id', SiteId)
        .gte('check_date', `${YearStr}-01-01`)
        .lt('check_date', CheckDate)
        .order('check_date', { ascending: true });

      if (PriorChecks && PriorChecks.length > 0) {
        const { data: Anchors } = await supabase
          .from('nest_check_entries')
          .select('compartment_id, nest_check_id, nestling_age_days')
          .in('nest_check_id', PriorChecks.map(c => c.id))
          .gt('young_count', 0)
          .not('nestling_age_days', 'is', null);

        if (Anchors) {
          for (const Chk of PriorChecks) {
            const A = Anchors.find(e => e.nest_check_id === Chk.id && (e.nestling_age_days ?? 0) > 0);
            if (A && !HatchDateMap.has(A.compartment_id)) {
              const [ay, am, ad] = Chk.check_date.split('-').map(Number);
              const Hatch = new Date(ay, am - 1, ad);
              Hatch.setDate(Hatch.getDate() - A.nestling_age_days!);
              HatchDateMap.set(
                A.compartment_id,
                `${Hatch.getFullYear()}-${String(Hatch.getMonth() + 1).padStart(2, '0')}-${String(Hatch.getDate()).padStart(2, '0')}`
              );
            }
          }
        }
      }

      // Previous check summaries — most recent entry per compartment across all prior checks
      const PrevEntryMap = new Map<string, PrevEntryData>();
      if (PriorChecks && PriorChecks.length > 0) {
        const { data: PrevEntries } = await supabase
          .from('nest_check_entries')
          .select('compartment_id, nest_check_id, species, is_empty_cavity, has_nest, nest_discarded, adult_present, renesting_attempt, nesting_attempt, egg_count, discarded_eggs, young_count, nestling_age_days, fledged_count')
          .in('nest_check_id', PriorChecks.map(c => c.id));
        if (PrevEntries) {
          // PriorChecks is sorted ascending — last entry per compartment wins
          const CheckDateMap = new Map(PriorChecks.map(c => [c.id, c.check_date]));
          const sorted = [...PrevEntries].sort((a, b) =>
            (CheckDateMap.get(a.nest_check_id) ?? '').localeCompare(CheckDateMap.get(b.nest_check_id) ?? '')
          );
          for (const E of sorted) {
            const summary = buildEntrySummary(E as any);
            if (summary === null) continue; // unchecked entries don't overwrite real prior data
            PrevEntryMap.set(E.compartment_id, {
              summary,
              species:           E.species,
              is_empty_cavity:   E.is_empty_cavity,
              has_nest:          E.has_nest,
              nest_discarded:    !!E.nest_discarded,
              adult_present:     !!E.adult_present,
              egg_count:         E.egg_count,
              discarded_eggs:    E.discarded_eggs,
              young_count:       E.young_count,
              nestling_age_days: E.nestling_age_days ?? null,
              fledged_count:     E.fledged_count ?? 0,
              nesting_attempt:   (E as any).nesting_attempt ?? 1,
              renesting_attempt: !!E.renesting_attempt,
            });
          }
        }
      }

      const { data: NestSeasonRows } = await supabase
        .from('nest_seasons')
        .select('compartment_id, male_age, female_age')
        .eq('site_season_id', SeasonId);
      cacheNestSeasons(
        (NestSeasonRows ?? []).map(NS => ({ ...NS, site_season_id: SeasonId }))
      ).catch(() => {});

      const TypedUnits: UnitRow[] = (Units ?? []).map(U => ({
        id: U.id, name: U.name,
        compartments: ((U.compartments as any[]) ?? []).map((C: any) => ({
          id: C.id, cavity_label: C.cavity_label, sort_order: C.sort_order ?? null, housing_type: C.housing_type ?? null,
        })),
      }));
      buildSections(TypedUnits, (Entries ?? []) as EntryRow[], BandingSet, HatchDateMap, NestSeasonRows ?? [], PrevEntryMap);
    } catch {
      // Offline or network error: fall back to local DB (no-op on web — SQLite not available)
      try {
        const LocalUnits    = await getLocalUnitsWithCompartments(SeasonId);
        const LocalEntries  = (await getLocalEntriesForCheck(CheckId)).map(localEntryToJs);
        const LocalBandSet  = await getLocalBandEntryIds(LocalEntries.map(E => E.id));
        const LocalSeasons  = await getLocalNestSeasons(SeasonId);
        const LocalUnitsTyped = LocalUnits.map(U => ({
          ...U,
          compartments: U.compartments.map(C => ({ ...C, housing_type: null as string | null })),
        }));
        buildSections(LocalUnitsTyped, LocalEntries as EntryRow[], LocalBandSet, new Map(), LocalSeasons, new Map());
      } catch {
        buildSections([], [], new Set(), new Map(), [], new Map());
      }
    }
  }

  // ── Edit date handlers ─────────────────────────────────────────────
  function openEditDate() {
    setEditDateValue(CheckDate);
    setEditDateError('');
    setEditDateVisible(true);
  }

  async function handleSaveDate() {
    const Val = EditDateValue.trim();
    if (!Val) { setEditDateError('Please enter a date.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(Val)) {
      setEditDateError('Use YYYY-MM-DD format, e.g. 2026-06-01.');
      return;
    }
    setEditDateLoading(true);
    const { error } = await supabase.from('nest_checks').update({ check_date: Val }).eq('id', CheckId);
    setEditDateLoading(false);
    if (error) { setEditDateError(friendlyError(error, 'Failed to update date.')); return; }
    setEditDateVisible(false);
    navigation.setParams({ CheckDate: Val });
  }

  // ── Delete check handler ───────────────────────────────────────────
  async function handleDeleteCheck() {
    setDeleting(true);
    setDeleteError('');
    const { error } = await supabase.from('nest_checks').delete().eq('id', CheckId);
    setDeleting(false);
    if (error) { setDeleteError(friendlyError(error, 'Failed to delete check.')); return; }
    setDeleteVisible(false);
    navigation.goBack();
  }

  async function handleMarkAllEmpty() {
    if (!CanWrite) return;
    const Unrecorded = Sections.flatMap(s => s.data).filter(c => c.entry_id === null);
    if (Unrecorded.length === 0) return;

    // Identify unrecorded compartments whose young are past fledge age — same check
    // used by the per-compartment quick-save fledge prompt.
    const FledgeReady = Unrecorded.filter(
      c => c.prev_entry && c.prev_entry.young_count > 0 &&
           c.calculated_nestling_age !== null && c.calculated_nestling_age >= 26
    );
    const FledgeCounts = new Map<string, number>();
    if (FledgeReady.length > 0) {
      const TotalYoung = FledgeReady.reduce((n, c) => n + c.prev_entry!.young_count, 0);
      const NestWord   = FledgeReady.length === 1 ? 'nest' : 'nests';
      const YoungWord  = TotalYoung === 1 ? 'young was' : 'young were';
      const choice = await new Promise<'fledged' | 'not_fledged' | 'cancel'>(resolve =>
        Alert.alert(
          'Young may have fledged',
          `${FledgeReady.length} ${NestWord} had ${TotalYoung} ${YoungWord} old enough to fledge. Mark them as fledged?`,
          [
            { text: 'Keep editing', onPress: () => resolve('cancel') },
            { text: 'Not fledged',  onPress: () => resolve('not_fledged') },
            { text: 'Mark as fledged', onPress: () => resolve('fledged') },
          ],
        )
      );
      if (choice === 'cancel') return;
      if (choice === 'fledged') {
        for (const c of FledgeReady) FledgeCounts.set(c.id, c.prev_entry!.young_count);
      }
    }

    setMarkingAllEmpty(true);
    const AttemptByCompartment = new Map(
      Unrecorded.map(item => [item.id, item.prev_entry?.nesting_attempt ?? 1])
    );
    const basePayload = {
      species: 'PM' as const, is_empty_cavity: true, has_nest: false, adult_present: false,
      nest_discarded: false, nest_replaced: false,
      egg_count: 0, discarded_eggs: 0, young_count: 0,
      nestling_age_days: null, nestling_age_notes: null as null,
      dead_young_count: 0, dead_adult_sex: null,
      renesting_attempt: false, notes: null,
      observed_male_age: null, observed_female_age: null, gourd_removed: false,
    };
    const Payload = (compartmentId: string) => ({
      ...basePayload,
      fledged_count: FledgeCounts.get(compartmentId) ?? 0,
      nesting_attempt: AttemptByCompartment.get(compartmentId) ?? 1,
    });
    // Generate stable IDs upfront so local and Supabase writes use the same ones
    const NewItems = Unrecorded.map(item => ({ id: makeId(), compartment_id: item.id }));
    try {
      await Promise.all(NewItems.map(({ id, compartment_id }) =>
        upsertLocalEntry({ id, nest_check_id: CheckId, compartment_id, ...Payload(compartment_id) })
      ));
    } catch {}
    // Write-through to Supabase so navigating away immediately shows correct data
    try {
      await supabase.from('nest_check_entries').upsert(
        NewItems.map(({ id, compartment_id }) => ({ id, nest_check_id: CheckId, compartment_id, ...Payload(compartment_id) }))
      );
    } catch {}
    syncNow();
    setMarkingAllEmpty(false);
    // Optimistic update for all newly-emptied compartments
    const EmptiedMap = new Map(NewItems.map(i => [i.compartment_id, i.id]));
    setSections(prev => prev.map(sec => ({
      ...sec,
      data: sec.data.map(row => !EmptiedMap.has(row.id) ? row : {
        ...row,
        entry_id: EmptiedMap.get(row.id)!,
        entry_summary: 'Empty cavity',
      }),
    })));
  }

  async function performQuickSave(item: CompartmentRow, type: 'empty' | 'pm_nest', fledgedCount: number) {
    if (!CanWrite) return;
    const Key = `${item.id}:${type}`;
    setQuickSaving(Key);
    const EntryId = item.entry_id ?? makeId();
    const QuickPayload = {
      species: 'PM' as const, is_empty_cavity: type === 'empty', has_nest: type === 'pm_nest', adult_present: false,
      nest_discarded: false, nest_replaced: false,
      egg_count: 0, discarded_eggs: 0, young_count: 0,
      nestling_age_days: null, nestling_age_notes: null as null,
      dead_young_count: 0, dead_adult_sex: null,
      fledged_count: fledgedCount, renesting_attempt: false, notes: null,
      observed_male_age: null, observed_female_age: null, gourd_removed: false,
      nesting_attempt: item.prev_entry?.nesting_attempt ?? 1,
    };
    try {
      await upsertLocalEntry({ id: EntryId, nest_check_id: CheckId, compartment_id: item.id, ...QuickPayload });
    } catch {}
    // Write-through to Supabase so the next screen sees current data without waiting for sync
    try {
      await supabase.from('nest_check_entries').upsert({ id: EntryId, nest_check_id: CheckId, compartment_id: item.id, ...QuickPayload });
    } catch {}
    syncNow();
    setQuickSaving(null);
    setSections(prev => prev.map(sec => ({
      ...sec,
      data: sec.data.map(row => row.id !== item.id ? row : {
        ...row,
        entry_id: EntryId,
        entry_summary: buildEntrySummary(QuickPayload),
      }),
    })));
  }

  async function handleQuick(item: CompartmentRow, type: 'empty' | 'pm_nest') {
    if (item.prev_entry && item.prev_entry.young_count > 0) {
      const Age = item.calculated_nestling_age;
      if (Age !== null && Age >= 26) {
        setFledgePromptCount(item.prev_entry.young_count);
        setFledgePromptItem(item);
        setFledgePromptType(type);
        setFledgePromptVisible(true);
        return;
      }
    }
    await performQuickSave(item, type, 0);
  }

  async function handleSameAsPrior(item: CompartmentRow) {
    if (!CanWrite) return;
    if (!item.prev_entry) return;
    const Key = `${item.id}:same`;
    setQuickSaving(Key);
    const EntryId = item.entry_id ?? makeId();
    const Prev = item.prev_entry;
    const Payload = {
      species: Prev.species as 'PM',
      is_empty_cavity: Prev.is_empty_cavity,
      has_nest: Prev.has_nest,
      adult_present: false,
      nest_discarded: false,
      nest_replaced: false,
      egg_count: Math.max(0, Prev.egg_count - Prev.discarded_eggs),
      discarded_eggs: 0,
      young_count: Prev.young_count,
      nestling_age_days: null,
      nestling_age_notes: null as null,
      dead_young_count: 0,
      dead_adult_sex: null,
      fledged_count: 0,
      nesting_attempt: Prev.nesting_attempt,
      renesting_attempt: false,
      notes: null,
      observed_male_age: null,
      observed_female_age: null,
      gourd_removed: false,
    };
    let savedLocally = false;
    try {
      await upsertLocalEntry({ id: EntryId, nest_check_id: CheckId, compartment_id: item.id, ...Payload });
      savedLocally = true;
    } catch {}
    // Write-through to Supabase so loadEntry always reads the correct nesting_attempt
    try {
      if (item.entry_id) {
        await supabase.from('nest_check_entries').update(Payload).eq('id', item.entry_id);
      } else {
        await supabase.from('nest_check_entries').upsert({ id: EntryId, nest_check_id: CheckId, compartment_id: item.id, ...Payload });
      }
    } catch {}
    syncNow();
    setQuickSaving(null);
    setSections(prev => prev.map(sec => ({
      ...sec,
      data: sec.data.map(row => row.id !== item.id ? row : {
        ...row,
        entry_id: EntryId,
        entry_summary: buildEntrySummary({ ...Payload, nestling_age_days: null }),
      }),
    })));
  }

  function navigateToEntry(item: CompartmentRow) {
    const AllCompartments = Sections.flatMap(s => s.data).map(c => ({
      id: c.id, cavity_label: c.cavity_label, unit_name: c.unit_name, entry_id: c.entry_id,
    }));
    navigation.navigate('NestCheckEntry', {
      CheckId,
      CheckDate,
      SeasonId,
      SiteId,
      CompartmentId:    item.id,
      CompartmentLabel: item.cavity_label,
      UnitName:         item.unit_name,
      HousingType:      item.housing_type ?? undefined,
      ExistingEntryId:  item.entry_id,
      AllCompartments,
      CompartmentIndex: AllCompartments.findIndex(c => c.id === item.id),
    });
  }

  const TotalCount   = Sections.reduce((S, Sec) => S + Sec.data.length, 0);
  const EnteredCount = Sections.reduce((S, Sec) => S + Sec.data.filter((C) => C.entry_id).length, 0);

  if (Loading) {
    return (
      <View style={styles.LoadingContainer}>
        <Text variant="bodyMedium">Loading compartments…</Text>
      </View>
    );
  }

  return (
    <>
      <SectionList
        sections={Sections.map(s => ({
          ...s,
          data: CollapsedUnits.has(s.unit_id) ? [] : s.data,
        }))}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.List}
        ListHeaderComponent={(
          <View style={styles.Header}>
            {!isOnline && (
              <Text variant="bodySmall" style={styles.OfflineBanner}>
                Offline · showing cached data
              </Text>
            )}
            <Text variant="bodyMedium" style={styles.Stats}>
              {TotalCount} compartments · {EnteredCount} entered
            </Text>
            {CanWrite && <View style={styles.HeaderBtns}>
              <Button mode="outlined" compact disabled={!isOnline} onPress={openEditDate} style={styles.EditDateBtn}>
                Edit date
              </Button>
              {CanManage && <Button
                mode="outlined" compact textColor="red" disabled={!isOnline}
                style={[styles.EditDateBtn, styles.DeleteBtn]}
                onPress={() => { setDeleteError(''); setDeleteVisible(true); }}
              >
                Delete check
              </Button>}
            </View>}
            {CanWrite && TotalCount > EnteredCount && (
              <Button
                mode="contained-tonal"
                compact
                loading={MarkingAllEmpty}
                disabled={MarkingAllEmpty || QuickSaving !== null}
                onPress={handleMarkAllEmpty}
                style={styles.MarkAllEmptyBtn}
              >
                Mark {TotalCount - EnteredCount} unrecorded as empty
              </Button>
            )}
          </View>
        )}
        renderSectionHeader={({ section }) => (
          <Pressable
            style={styles.SectionHeaderRow}
            onPress={() => setCollapsedUnits(prev => {
              const next = new Set(prev);
              if (next.has(section.unit_id)) next.delete(section.unit_id);
              else next.add(section.unit_id);
              return next;
            })}
          >
            <Text variant="labelLarge" style={styles.SectionHeader}>{section.title}</Text>
            <IconButton
              icon={CollapsedUnits.has(section.unit_id) ? 'chevron-down' : 'chevron-up'}
              size={16}
              style={styles.SectionChevron}
            />
          </Pressable>
        )}
        renderItem={({ item }) => (
          <Card style={styles.Card} mode="outlined" onPress={CanWrite ? () => navigateToEntry(item) : undefined}>
            <Card.Title
              title={item.cavity_label}
              subtitle={item.entry_summary ?? 'Not entered'}
              subtitleStyle={item.entry_summary ? styles.EnteredText : styles.PendingText}
              right={CanWrite ? () => (
                <IconButton
                  icon={item.entry_id ? 'pencil' : 'plus-circle-outline'}
                  size={20}
                  style={styles.RowIcon}
                  onPress={() => navigateToEntry(item)}
                />
              ) : undefined}
            />
            {item.prev_summary && (!item.entry_id || !item.entry_has_nest) && (
              <Card.Content style={styles.PrevContent}>
                <Text style={styles.PrevText}>Prev: {item.prev_summary}</Text>
              </Card.Content>
            )}
            {CanWrite && <Card.Actions style={styles.QuickActions}>
              <Button
                compact mode="outlined"
                style={styles.QuickBtn}
                contentStyle={styles.QuickBtnContent}
                loading={QuickSaving === `${item.id}:empty`}
                disabled={QuickSaving !== null}
                onPress={() => handleQuick(item, 'empty')}
              >
                Empty
              </Button>
              <Button
                compact mode="outlined"
                style={styles.QuickBtn}
                contentStyle={styles.QuickBtnContent}
                loading={QuickSaving === `${item.id}:pm_nest`}
                disabled={QuickSaving !== null}
                onPress={() => handleQuick(item, 'pm_nest')}
              >
                PM Nest
              </Button>
              {!item.entry_id && item.prev_entry && (
                <Button
                  compact mode="outlined"
                  style={styles.QuickBtn}
                  contentStyle={styles.QuickBtnContent}
                  loading={QuickSaving === `${item.id}:same`}
                  disabled={QuickSaving !== null}
                  onPress={() => handleSameAsPrior(item)}
                >
                  Copy Prev
                </Button>
              )}
            </Card.Actions>}
          </Card>
        )}
        ListEmptyComponent={(
          <View style={styles.EmptyContainer}>
            <Text variant="bodyMedium" style={styles.EmptyText}>
              No housing units or compartments have been set up for this site yet.
            </Text>
            {CanWrite && <Button
              mode="outlined"
              onPress={() => navigation.navigate('CreateHousingUnit', { SiteId, SeasonId })}
            >
              Add Housing Unit
            </Button>}
          </View>
        )}
      />

      <Portal>
        {/* ── Fledge prompt ─────────────────────────────────────── */}
        <Dialog visible={FledgePromptVisible} onDismiss={() => setFledgePromptVisible(false)}>
          <Dialog.Title>Young old enough to fledge</Dialog.Title>
          <Dialog.Content>
            <Text>
              {FledgePromptCount} young disappeared since the last check and {FledgePromptCount === 1 ? 'was' : 'were'} old enough to fledge. Mark {FledgePromptCount === 1 ? 'it' : 'them'} as fledged?
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setFledgePromptVisible(false)}>Keep editing</Button>
            <Button onPress={() => {
              setFledgePromptVisible(false);
              if (FledgePromptItem) performQuickSave(FledgePromptItem, FledgePromptType, 0);
            }}>No</Button>
            <Button onPress={() => {
              setFledgePromptVisible(false);
              if (FledgePromptItem) performQuickSave(FledgePromptItem, FledgePromptType, FledgePromptCount);
            }}>Yes</Button>
          </Dialog.Actions>
        </Dialog>

        {/* ── Edit date ─────────────────────────────────────────── */}
        <Dialog visible={EditDateVisible} onDismiss={() => setEditDateVisible(false)}>
          <Dialog.Title>Edit check date</Dialog.Title>
          <Dialog.Content>
            <DateInput
              label="Check date"
              value={EditDateValue}
              onChange={setEditDateValue}
              style={styles.DialogInput}
            />
            {EditDateError ? <HelperText type="error" visible>{EditDateError}</HelperText> : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setEditDateVisible(false)}>Cancel</Button>
            <Button loading={EditDateLoading} onPress={handleSaveDate}>Save</Button>
          </Dialog.Actions>
        </Dialog>

        {/* ── Delete check ──────────────────────────────────────── */}
        <Dialog visible={DeleteVisible} onDismiss={() => setDeleteVisible(false)}>
          <Dialog.Title>Delete this nest check?</Dialog.Title>
          <Dialog.Content>
            <Text>
              This will permanently delete the nest check and all compartment entries recorded
              during it. This cannot be undone.
            </Text>
            {DeleteError ? <HelperText type="error" visible>{DeleteError}</HelperText> : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteVisible(false)}>Cancel</Button>
            <Button textColor="red" loading={Deleting} onPress={handleDeleteCheck}>Delete</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  LoadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  List:             { padding: 16, paddingBottom: 32 },
  Header:           { marginBottom: 8 },
  OfflineBanner:    { color: '#b45309', marginBottom: 6, fontStyle: 'italic' },
  Stats:            { color: '#555', marginBottom: 8 },
  HeaderBtns:       { flexDirection: 'row', gap: 8 },
  EditDateBtn:      { flex: 1 },
  DeleteBtn:        { borderColor: 'red' },
  SectionHeaderRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, marginBottom: 2 },
  SectionHeader:    { flex: 1, marginBottom: 0, paddingHorizontal: 4 },
  SectionChevron:   { margin: 0 },
  Card:             { marginBottom: 8 },
  QuickActions:     { paddingHorizontal: 4, paddingBottom: 4, gap: 3, justifyContent: 'flex-start' },
  QuickBtn:         { alignSelf: 'flex-start', marginHorizontal: 0 },
  QuickBtnContent:  { paddingHorizontal: 0 },
  EnteredText:      { color: '#2e7d32' },
  PendingText:      { color: '#999' },
  RowIcon:          { marginRight: 4 },
  EmptyContainer:   { padding: 16, alignItems: 'flex-start' },
  EmptyText:        { color: '#666', marginBottom: 12 },
  MarkAllEmptyBtn:  { marginTop: 10, alignSelf: 'stretch' },
  PrevContent:      { paddingTop: 0, paddingBottom: 4 },
  PrevText:         { color: '#999', fontStyle: 'italic', fontSize: 12 },
  DialogInput:      { marginBottom: 8 },
});
