import React, { useCallback, useState } from 'react';
import { SectionList, StyleSheet, View } from 'react-native';
import { Button, Card, Dialog, HelperText, IconButton, Portal, Text, TextInput } from 'react-native-paper';
import DateInput from '../components/DateInput';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { AppStackParamList } from '../App';

type CompartmentRow = {
  id: string;
  cavity_label: string;
  sort_order: number | null;
  unit_id: string;
  unit_name: string;
  entry_id: string | null;
  entry_summary: string | null;
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
  species: string; is_empty_cavity: boolean; has_nest: boolean;
  egg_count: number; young_count: number; nestling_age_days: number | null;
}): string {
  if (entry.is_empty_cavity) return 'Empty cavity';
  if (!entry.has_nest) return 'No nest';
  const IsPM = entry.species === 'PM';
  const Parts = [SpeciesLabel[entry.species] ?? entry.species];
  if (IsPM && entry.egg_count > 0)   Parts.push(`${entry.egg_count} eggs`);
  if (IsPM && entry.young_count > 0) {
    Parts.push(`${entry.young_count} young`);
    if (entry.nestling_age_days === 0)        Parts.push('HD');
    else if (entry.nestling_age_days != null) Parts.push(`${entry.nestling_age_days}do`);
  }
  return Parts.join(' · ');
}

export default function NestCheckDetailScreen({ navigation, route }: Props) {
  const { CheckId, CheckDate, SiteId, SeasonId, Year } = route.params;

  const [Sections, setSections] = useState<Section[]>([]);
  const [Loading, setLoading]   = useState(true);

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
    const { data: Units } = await supabase
      .from('housing_units')
      .select('id, name, compartments(id, cavity_label, sort_order)')
      .eq('site_id', SiteId)
      .order('name');

    const { data: Entries } = await supabase
      .from('nest_check_entries')
      .select('id, compartment_id, species, is_empty_cavity, has_nest, egg_count, young_count, nestling_age_days')
      .eq('nest_check_id', CheckId);

    // Build a hatch-date map (compartment_id → hatch date string) from prior checks
    // so we can compute nestling age on this check date even when it wasn't stored.
    const HatchDateMap = new Map<string, string>();
    const Year = CheckDate.substring(0, 4);
    const { data: PriorChecks } = await supabase
      .from('nest_checks')
      .select('id, check_date')
      .eq('site_id', SiteId)
      .gte('check_date', `${Year}-01-01`)
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

    const EntryMap = new Map<string, NonNullable<typeof Entries>[number]>();
    (Entries ?? []).forEach((E) => EntryMap.set(E.compartment_id, E));

    const Built: Section[] = (Units ?? []).map((Unit) => ({
      title:   Unit.name,
      unit_id: Unit.id,
      data: ((Unit.compartments as any[]) ?? [])
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
            }) : null,
          };
        }),
    }));

    setSections(Built);
    setLoading(false);
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

  function navigateToEntry(item: CompartmentRow) {
    navigation.navigate('NestCheckEntry', {
      CheckId,
      CheckDate,
      SeasonId,
      SiteId,
      CompartmentId:    item.id,
      CompartmentLabel: item.cavity_label,
      UnitName:         item.unit_name,
      ExistingEntryId:  item.entry_id,
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
            <Text variant="bodyMedium" style={styles.Stats}>
              {TotalCount} compartments · {EnteredCount} entered
            </Text>
            <View style={styles.HeaderBtns}>
              <Button mode="outlined" compact onPress={openEditDate} style={styles.EditDateBtn}>
                Edit date
              </Button>
              <Button
                mode="outlined" compact textColor="red"
                style={[styles.EditDateBtn, styles.DeleteBtn]}
                onPress={() => { setDeleteError(''); setDeleteVisible(true); }}
              >
                Delete check
              </Button>
            </View>
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
  Stats:            { color: '#555', marginBottom: 8 },
  HeaderBtns:       { flexDirection: 'row', gap: 8 },
  EditDateBtn:      { flex: 1 },
  DeleteBtn:        { borderColor: 'red' },
  SectionHeader:    { marginTop: 16, marginBottom: 6, paddingHorizontal: 4 },
  Card:             { marginBottom: 8 },
  EnteredText:      { color: '#2e7d32' },
  PendingText:      { color: '#999' },
  RowIcon:          { marginRight: 4 },
  EmptyContainer:   { padding: 16, alignItems: 'flex-start' },
  EmptyText:        { color: '#666', marginBottom: 12 },
  DialogInput:      { marginBottom: 8 },
});
