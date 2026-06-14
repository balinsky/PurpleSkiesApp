import React, { useCallback, useState } from 'react';
import { SectionList, StyleSheet, View } from 'react-native';
import { Button, Card, Dialog, HelperText, IconButton, Portal, Text, TextInput } from 'react-native-paper';
import DateInput from '../components/DateInput';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { AppStackParamList } from '../App';
import { useSync } from '../contexts/SyncContext';
import {
  cacheUnitsAndCompartments, getLocalUnitsWithCompartments,
  cacheEntries, getLocalEntriesForCheck,
  getLocalBandEntryIds, localEntryToJs,
  cacheNestSeasons, getLocalNestSeasons,
  upsertLocalEntry, makeId,
} from '../lib/localDb';

type CompartmentRow = {
  id: string;
  cavity_label: string;
  sort_order: number | null;
  unit_id: string;
  unit_name: string;
  entry_id: string | null;
  entry_summary: string | null;
  prev_summary: string | null;
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

const SpeciesLabel: Record<string, string> = {
  PM: 'Purple Martin', HS: 'House Sparrow', ST: 'Starling',
  TS: 'Tree Swallow',  BB: 'Bluebird',      HW: 'House Wren',
};

function buildEntrySummary(entry: {
  species: string; is_empty_cavity: boolean; has_nest: boolean; nest_discarded: boolean;
  adult_present?: boolean;
  egg_count: number; discarded_eggs: number; young_count: number; nestling_age_days: number | null;
  renesting_attempt?: boolean;
  male_age?: string | null; female_age?: string | null; has_banding?: boolean;
}): string {
  if (entry.is_empty_cavity) return 'Empty cavity';
  if (entry.adult_present) return 'Adult present · not checked';
  if (!entry.has_nest) return 'No nest';
  const IsPM = entry.species === 'PM';
  const SpeciesName = SpeciesLabel[entry.species] ?? entry.species;
  const NetEggs = Math.max(0, entry.egg_count - entry.discarded_eggs);
  const Parts: string[] = [];
  if (!IsPM || (NetEggs === 0 && entry.young_count === 0 && entry.discarded_eggs === 0)) {
    Parts.push(`${SpeciesName} nest`);
  } else {
    Parts.push(SpeciesName);
    if (entry.egg_count > 0 && entry.discarded_eggs > 0) {
      Parts.push(`${entry.egg_count} ${entry.egg_count === 1 ? 'egg' : 'eggs'}, ${entry.discarded_eggs} discarded`);
    } else if (NetEggs > 0) {
      Parts.push(`${NetEggs} ${NetEggs === 1 ? 'egg' : 'eggs'}`);
    }
    if (entry.young_count > 0) {
      Parts.push(`${entry.young_count} young`);
      if (entry.nestling_age_days === 0)        Parts.push('HD');
      else if (entry.nestling_age_days != null) Parts.push(`${entry.nestling_age_days}do`);
    }
  }
  if (entry.nest_discarded) Parts.push('discarded');
  if (entry.renesting_attempt) Parts.push('RA');
  if (IsPM) {
    const AgeParts = [entry.male_age && `♂ ${entry.male_age}`, entry.female_age && `♀ ${entry.female_age}`].filter(Boolean);
    if (AgeParts.length > 0) Parts.push(AgeParts.join(' '));
  }
  if (entry.has_banding) Parts.push('B');
  return Parts.join(' · ');
}

export default function NestCheckDetailScreen({ navigation, route }: Props) {
  const { CheckId, CheckDate, SiteId, SeasonId, Year } = route.params;
  const { syncNow, isOnline } = useSync();

  const [Sections, setSections] = useState<Section[]>([]);
  const [Loading, setLoading]   = useState(true);
  const [QuickSaving, setQuickSaving]     = useState<string | null>(null);
  const [MarkingAllEmpty, setMarkingAllEmpty] = useState(false);

  // ── Edit date ──────────────────────────────────────────────────────
  const [EditDateVisible, setEditDateVisible]   = useState(false);
  const [EditDateValue, setEditDateValue]       = useState('');
  const [EditDateLoading, setEditDateLoading]   = useState(false);
  const [EditDateError, setEditDateError]       = useState('');

  // ── Delete check ───────────────────────────────────────────────────
  const [DeleteVisible, setDeleteVisible] = useState(false);
  const [Deleting, setDeleting]           = useState(false);
  const [DeleteError, setDeleteError]     = useState('');

  useFocusEffect(useCallback(() => { loadData(); }, [CheckId, SiteId]));

  async function loadData() {
    type UnitRow = { id: string; name: string; compartments: { id: string; cavity_label: string; sort_order: number | null }[] };
    type EntryRow = { id: string; compartment_id: string; species: string; is_empty_cavity: boolean; has_nest: boolean; nest_discarded: boolean; adult_present: boolean; renesting_attempt: boolean; egg_count: number; discarded_eggs: number; young_count: number; nestling_age_days: number | null };
    type SeasonRow = { compartment_id: string; male_age: string | null; female_age: string | null };

    function buildSections(
      Units: UnitRow[], Entries: EntryRow[], BandingSet: Set<string>,
      HatchDateMap: Map<string, string>, SeasonRows: SeasonRow[],
      PrevEntryMap: Map<string, string>,
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
              entry_id:      Entry?.id ?? null,
              entry_summary: Entry ? buildEntrySummary({
                ...Entry,
                nestling_age_days: effectiveAge(C.id, Entry.nestling_age_days),
                ...AgeMap.get(C.id),
                has_banding: BandingSet.has(Entry.id),
              }) : null,
              prev_summary:  PrevEntryMap.get(C.id) ?? null,
            };
          }),
      })));
      setLoading(false);
    }

    try {
      const { data: Units, error: UnitsError } = await supabase
        .from('housing_units')
        .select('id, name, compartments(id, cavity_label, sort_order)')
        .eq('site_id', SiteId)
        .order('name');
      if (UnitsError) throw UnitsError;

      const { data: RemoteEntries, error: EntriesError } = await supabase
        .from('nest_check_entries')
        .select('id, compartment_id, species, is_empty_cavity, has_nest, nest_discarded, adult_present, renesting_attempt, egg_count, discarded_eggs, young_count, nestling_age_days')
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
        (Units ?? []).map(U => ({ id: U.id, name: U.name, site_id: SiteId })),
        (Units ?? []).flatMap(U =>
          ((U.compartments as any[]) ?? []).map((C: any) => ({
            id: C.id, housing_unit_id: U.id, cavity_label: C.cavity_label, sort_order: C.sort_order ?? null,
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
      const PrevEntryMap = new Map<string, string>();
      if (PriorChecks && PriorChecks.length > 0) {
        const { data: PrevEntries } = await supabase
          .from('nest_check_entries')
          .select('compartment_id, nest_check_id, species, is_empty_cavity, has_nest, nest_discarded, adult_present, renesting_attempt, egg_count, discarded_eggs, young_count, nestling_age_days')
          .in('nest_check_id', PriorChecks.map(c => c.id));
        if (PrevEntries) {
          // PriorChecks is sorted ascending — last entry per compartment wins
          const CheckDateMap = new Map(PriorChecks.map(c => [c.id, c.check_date]));
          const sorted = [...PrevEntries].sort((a, b) =>
            (CheckDateMap.get(a.nest_check_id) ?? '').localeCompare(CheckDateMap.get(b.nest_check_id) ?? '')
          );
          for (const E of sorted) {
            PrevEntryMap.set(E.compartment_id, buildEntrySummary(E as any));
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
          id: C.id, cavity_label: C.cavity_label, sort_order: C.sort_order ?? null,
        })),
      }));
      buildSections(TypedUnits, (Entries ?? []) as EntryRow[], BandingSet, HatchDateMap, NestSeasonRows ?? [], PrevEntryMap);
    } catch {
      // Offline or network error: fall back to local DB (no-op on web — SQLite not available)
      try {
        const LocalUnits    = await getLocalUnitsWithCompartments(SiteId);
        const LocalEntries  = (await getLocalEntriesForCheck(CheckId)).map(localEntryToJs);
        const LocalBandSet  = await getLocalBandEntryIds(LocalEntries.map(E => E.id));
        const LocalSeasons  = await getLocalNestSeasons(SeasonId);
        buildSections(LocalUnits, LocalEntries as EntryRow[], LocalBandSet, new Map(), LocalSeasons, new Map());
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
    if (error) { setEditDateError(error.message); return; }
    setEditDateVisible(false);
    navigation.setParams({ CheckDate: Val });
  }

  // ── Delete check handler ───────────────────────────────────────────
  async function handleDeleteCheck() {
    setDeleting(true);
    setDeleteError('');
    const { error } = await supabase.from('nest_checks').delete().eq('id', CheckId);
    setDeleting(false);
    if (error) { setDeleteError(error.message); return; }
    setDeleteVisible(false);
    navigation.goBack();
  }

  async function handleMarkAllEmpty() {
    const Unrecorded = Sections.flatMap(s => s.data).filter(c => c.entry_id === null);
    if (Unrecorded.length === 0) return;
    setMarkingAllEmpty(true);
    const Payload = {
      species: 'PM' as const, is_empty_cavity: true, has_nest: false, adult_present: false,
      nest_discarded: false, nest_replaced: false,
      egg_count: 0, discarded_eggs: 0, young_count: 0,
      nestling_age_days: null, nestling_age_notes: null as null,
      dead_young_count: 0, dead_adult_male: false, dead_adult_female: false,
      fledged_count: 0, renesting_attempt: false, notes: null,
      observed_male_age: null, observed_female_age: null,
    };
    let savedLocally = false;
    try {
      await Promise.all(Unrecorded.map(item =>
        upsertLocalEntry({ id: makeId(), nest_check_id: CheckId, compartment_id: item.id, ...Payload })
      ));
      savedLocally = true;
      syncNow();
    } catch {}
    if (!savedLocally) {
      await supabase.from('nest_check_entries').insert(
        Unrecorded.map(item => ({ id: makeId(), nest_check_id: CheckId, compartment_id: item.id, ...Payload }))
      );
    }
    setMarkingAllEmpty(false);
    // Optimistic update for all newly-emptied compartments
    const EmptiedIds = new Set(Unrecorded.map(c => c.id));
    setSections(prev => prev.map(sec => ({
      ...sec,
      data: sec.data.map(row => !EmptiedIds.has(row.id) ? row : {
        ...row,
        entry_id: row.entry_id ?? makeId(),
        entry_summary: 'Empty cavity',
      }),
    })));
  }

  async function handleQuick(item: CompartmentRow, type: 'empty' | 'pm_nest') {
    const Key = `${item.id}:${type}`;
    setQuickSaving(Key);
    const EntryId = item.entry_id ?? makeId();
    const QuickPayload = {
      species: 'PM' as const, is_empty_cavity: type === 'empty', has_nest: type === 'pm_nest', adult_present: false,
      nest_discarded: false, nest_replaced: false,
      egg_count: 0, discarded_eggs: 0, young_count: 0,
      nestling_age_days: null, nestling_age_notes: null as null,
      dead_young_count: 0, dead_adult_male: false, dead_adult_female: false,
      fledged_count: 0, renesting_attempt: false, notes: null,
      observed_male_age: null, observed_female_age: null,
    };
    let savedLocally = false;
    try {
      await upsertLocalEntry({ id: EntryId, nest_check_id: CheckId, compartment_id: item.id, ...QuickPayload });
      savedLocally = true;
      syncNow();
    } catch {}
    if (!savedLocally) {
      // Web: write directly to Supabase
      if (item.entry_id) {
        await supabase.from('nest_check_entries').update(QuickPayload).eq('id', item.entry_id);
      } else {
        await supabase.from('nest_check_entries').insert({ id: EntryId, nest_check_id: CheckId, compartment_id: item.id, ...QuickPayload });
      }
    }
    setQuickSaving(null);
    // Optimistic update: avoids racing loadData() against the background sync
    setSections(prev => prev.map(sec => ({
      ...sec,
      data: sec.data.map(row => row.id !== item.id ? row : {
        ...row,
        entry_id: EntryId,
        entry_summary: type === 'empty' ? 'Empty cavity' : 'Purple Martin nest',
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
        sections={Sections}
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
            <View style={styles.HeaderBtns}>
              <Button mode="outlined" compact disabled={!isOnline} onPress={openEditDate} style={styles.EditDateBtn}>
                Edit date
              </Button>
              <Button
                mode="outlined" compact textColor="red" disabled={!isOnline}
                style={[styles.EditDateBtn, styles.DeleteBtn]}
                onPress={() => { setDeleteError(''); setDeleteVisible(true); }}
              >
                Delete check
              </Button>
            </View>
            {TotalCount > EnteredCount && (
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
          <Text variant="labelLarge" style={styles.SectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <Card style={styles.Card} mode="outlined" onPress={() => navigateToEntry(item)}>
            <Card.Title
              title={item.cavity_label}
              subtitle={item.entry_summary ?? 'Not entered'}
              subtitleStyle={item.entry_summary ? styles.EnteredText : styles.PendingText}
              right={() => (
                <IconButton
                  icon={item.entry_id ? 'pencil' : 'plus-circle-outline'}
                  size={20}
                  style={styles.RowIcon}
                  onPress={() => navigateToEntry(item)}
                />
              )}
            />
            {item.prev_summary && !item.entry_id && (
              <Card.Content style={styles.PrevContent}>
                <Text style={styles.PrevText}>Prev: {item.prev_summary}</Text>
              </Card.Content>
            )}
            <Card.Actions style={styles.QuickActions}>
              <Button
                compact mode="outlined"
                style={styles.QuickBtn}
                loading={QuickSaving === `${item.id}:empty`}
                disabled={QuickSaving !== null}
                onPress={() => handleQuick(item, 'empty')}
              >
                Empty
              </Button>
              <Button
                compact mode="outlined"
                style={styles.QuickBtn}
                loading={QuickSaving === `${item.id}:pm_nest`}
                disabled={QuickSaving !== null}
                onPress={() => handleQuick(item, 'pm_nest')}
              >
                PM Nest
              </Button>
            </Card.Actions>
          </Card>
        )}
        ListEmptyComponent={(
          <View style={styles.EmptyContainer}>
            <Text variant="bodyMedium" style={styles.EmptyText}>
              No housing units or compartments have been set up for this site yet.
            </Text>
            <Button
              mode="outlined"
              onPress={() => navigation.navigate('CreateHousingUnit', { SiteId })}
            >
              Add Housing Unit
            </Button>
          </View>
        )}
      />

      <Portal>
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
  SectionHeader:    { marginTop: 16, marginBottom: 6, paddingHorizontal: 4 },
  Card:             { marginBottom: 8 },
  QuickActions:     { paddingHorizontal: 8, paddingBottom: 6, gap: 8, justifyContent: 'flex-start' },
  QuickBtn:         { alignSelf: 'flex-start' },
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
