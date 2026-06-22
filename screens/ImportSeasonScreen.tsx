import React, { useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, View } from 'react-native';
import { Button, Card, Chip, Divider, HelperText, List, Text } from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import { supabase } from '../lib/supabase';
import { makeId } from '../lib/localDb';
import { upsertLocalEntry, cacheNestChecks, cacheUnitsAndCompartments, upsertLocalNestSeason } from '../lib/localDb';
import { useSync } from '../contexts/SyncContext';
import { AppStackParamList } from '../App';
import {
  parseImportFile, exportErrorSheet,
  ImportSummary, ImportRow, ImportError,
} from '../lib/importXls';

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'ImportSeason'>;
  route: RouteProp<AppStackParamList, 'ImportSeason'>;
};

type ImportState = 'idle' | 'parsing' | 'ready' | 'importing' | 'done';

export default function ImportSeasonScreen({ navigation, route }: Props) {
  const { SiteId, SiteName } = route.params;
  const { syncNow } = useSync();

  const [State, setState] = useState<ImportState>('idle');
  const [ParseError, setParseError] = useState('');
  const [FileUri, setFileUri] = useState<string | null>(null);
  const [Summary, setSummary] = useState<ImportSummary | null>(null);
  const [ImportError2, setImportError2] = useState('');

  async function handlePickFile() {
    setParseError('');
    setState('parsing');
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/vnd.ms-excel',
               'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
               'text/csv', 'text/comma-separated-values', '*/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled) { setState('idle'); return; }

      const uri = result.assets[0].uri;
      setFileUri(uri);

      const parsed = await parseImportFile(uri);
      if (typeof parsed === 'string') {
        setParseError(parsed);
        setState('idle');
        return;
      }
      setSummary(parsed);
      setState('ready');
    } catch (e: any) {
      setParseError(e?.message ?? 'Unknown error reading file.');
      setState('idle');
    }
  }

  async function handleDownloadErrors() {
    if (!FileUri || !Summary) return;
    const path = await exportErrorSheet(FileUri, Summary.errors);
    if (path) {
      await Share.share({ url: path, title: 'Import errors' });
    } else {
      Alert.alert('Error', 'Could not generate error sheet.');
    }
  }

  async function runImport(skipErrors: boolean) {
    if (!Summary) return;
    setState('importing');
    setImportError2('');

    try {
      // Check if season already exists
      const { data: existing } = await supabase
        .from('site_seasons')
        .select('id, year')
        .eq('site_id', SiteId)
        .eq('year', Summary.year)
        .maybeSingle();

      let SeasonId: string;

      if (existing) {
        // Ask user to merge or cancel
        const choice = await new Promise<'merge' | 'cancel'>((resolve) => {
          Alert.alert(
            `${Summary.year} Season Exists`,
            `A ${Summary.year} season already exists for ${SiteName}. Merge (add missing checks/entries only) or cancel?`,
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') },
              { text: 'Merge',  style: 'default', onPress: () => resolve('merge') },
            ],
          );
        });
        if (choice === 'cancel') { setState('ready'); return; }
        SeasonId = existing.id;
      } else {
        // Create new season
        const { data: newSeason, error } = await supabase
          .from('site_seasons')
          .insert({ site_id: SiteId, year: Summary.year })
          .select('id')
          .single();
        if (error || !newSeason) {
          setImportError2('Failed to create season: ' + (error?.message ?? 'unknown error'));
          setState('ready');
          return;
        }
        SeasonId = newSeason.id;
      }

      // ── Build housing units and compartments ──────────────────────
      // Collect unique unit names from rows (housing_type defines the unit type)
      const UnitMap = new Map<string, { id: string; housing_type: string }>(); // name → {id, housing_type}
      for (const Row of Summary.rows) {
        const unitName = housingTypeName(Row.housing_type);
        if (!UnitMap.has(unitName)) {
          // Check if it exists in Supabase already
          const { data: existing } = await supabase
            .from('housing_units')
            .select('id')
            .eq('site_id', SiteId)
            .eq('site_season_id', SeasonId)
            .eq('name', unitName)
            .maybeSingle();

          if (existing) {
            UnitMap.set(unitName, { id: existing.id, housing_type: Row.housing_type });
          } else {
            const newId = makeId();
            const { error } = await supabase.from('housing_units').insert({
              id: newId, site_id: SiteId, site_season_id: SeasonId,
              name: unitName, housing_type: Row.housing_type,
            });
            if (!error) UnitMap.set(unitName, { id: newId, housing_type: Row.housing_type });
          }
        }
      }

      // Cache housing units locally
      await cacheUnitsAndCompartments(
        [...UnitMap.entries()].map(([name, { id }]) => ({ id, name, site_id: SiteId, site_season_id: SeasonId })),
        [],
      );

      // Compartments — keyed by unitName + bare cavity label (attempt 1 only for dedup)
      const CompMap = new Map<string, string>(); // `${unitName}:${bare}` → compartment_id
      for (const Row of Summary.rows) {
        const unitName = housingTypeName(Row.housing_type);
        const unit = UnitMap.get(unitName);
        if (!unit) continue;
        const compKey = `${unitName}:${Row.cavity_label}`;
        if (!CompMap.has(compKey)) {
          const { data: existing } = await supabase
            .from('compartments')
            .select('id')
            .eq('housing_unit_id', unit.id)
            .eq('cavity_label', Row.cavity_label)
            .maybeSingle();

          if (existing) {
            CompMap.set(compKey, existing.id);
          } else {
            const newId = makeId();
            const { error } = await supabase.from('compartments').insert({
              id: newId, housing_unit_id: unit.id, site_season_id: SeasonId,
              cavity_label: Row.cavity_label, housing_type: Row.housing_type,
              hole_type: Row.hole_type || null, sort_order: null,
            });
            if (!error) CompMap.set(compKey, newId);
          }
        }
      }

      // Cache compartments locally
      await cacheUnitsAndCompartments([], [...CompMap.entries()].map(([key, id]) => {
        const [unitName, label] = key.split(':');
        const unit = UnitMap.get(unitName)!;
        return { id, housing_unit_id: unit.id, cavity_label: label, sort_order: null, site_season_id: SeasonId };
      }));

      // ── Build nest checks (one per date) ──────────────────────────
      const { data: { user } } = await supabase.auth.getUser();
      const CheckMap = new Map<string, string>(); // ISO date → check_id

      for (const date of Summary.check_dates) {
        const { data: existing } = await supabase
          .from('nest_checks')
          .select('id')
          .eq('site_id', SiteId)
          .eq('check_date', date)
          .maybeSingle();

        if (existing) {
          CheckMap.set(date, existing.id);
        } else {
          const newId = makeId();
          const { error } = await supabase.from('nest_checks').insert({
            id: newId, site_id: SiteId, check_date: date, created_by: user?.id ?? null,
          });
          if (!error) CheckMap.set(date, newId);
        }
      }

      await cacheNestChecks(
        [...CheckMap.entries()].map(([check_date, id]) => ({ id, site_id: SiteId, check_date }))
      );

      // ── Write nest check entries ───────────────────────────────────
      for (const Row of Summary.rows) {
        const unitName = housingTypeName(Row.housing_type);
        const compKey  = `${unitName}:${Row.cavity_label}`;
        const CompId   = CompMap.get(compKey);
        if (!CompId) continue;

        for (const { date, result } of Row.checks) {
          if (!result.ok && skipErrors) continue;
          if (!result.ok) continue; // always skip errors in DB write — they can't be stored

          const CheckId = CheckMap.get(date);
          if (!CheckId) continue;

          const D = result.data;

          // Check if entry already exists (merge mode)
          const { data: existingEntry } = await supabase
            .from('nest_check_entries')
            .select('id')
            .eq('nest_check_id', CheckId)
            .eq('compartment_id', CompId)
            .eq('nesting_attempt', Row.nesting_attempt)
            .maybeSingle();

          if (existingEntry) continue; // don't overwrite

          const EntryId = makeId();
          const Payload = {
            id: EntryId, nest_check_id: CheckId, compartment_id: CompId,
            species: D.is_empty_cavity ? 'PM' : D.species,
            is_empty_cavity: D.is_empty_cavity,
            has_nest: D.has_nest,
            nest_discarded: D.nest_discarded,
            nest_replaced: false,
            adult_present: false,
            egg_count: D.egg_count,
            discarded_eggs: D.discarded_eggs,
            young_count: D.young_count,
            nestling_age_days: D.nestling_age_days,
            nestling_age_notes: null as null,
            dead_young_count: D.dead_young_count,
            dead_adult_sex: D.dead_adult_sex,
            fledged_count: 0,
            renesting_attempt: Row.nesting_attempt > 1,
            nesting_attempt: Row.nesting_attempt,
            notes: null as null,
            observed_male_age: null as null,
            observed_female_age: null as null,
            gourd_removed: D.gourd_removed,
          };

          await upsertLocalEntry(Payload);
          await supabase.from('nest_check_entries').upsert(Payload);
        }

        // ── nest_seasons (male/female age) ────────────────────────
        if (Row.male_age || Row.female_age) {
          await upsertLocalNestSeason({
            compartment_id: CompId, site_season_id: SeasonId, year: Summary.year,
            male_age: Row.male_age, female_age: Row.female_age,
          });
          await supabase.from('nest_seasons').upsert({
            compartment_id: CompId, site_season_id: SeasonId, year: Summary.year,
            male_age: Row.male_age, female_age: Row.female_age,
          });
        }
      }

      syncNow();
      setState('done');

      navigation.replace('SeasonDetail', { SeasonId, SiteId, Year: Summary.year });
    } catch (e: any) {
      setImportError2(e?.message ?? 'Import failed.');
      setState('ready');
    }
  }

  const errorCount  = Summary?.errors.length ?? 0;
  const totalChecks = Summary ? Summary.rows.reduce((n, r) => n + r.checks.length, 0) : 0;
  const okChecks    = Summary ? Summary.rows.reduce((n, r) => n + r.checks.filter(c => c.result.ok).length, 0) : 0;

  return (
    <ScrollView contentContainerStyle={styles.Container}>

      {/* ── Step 1: pick file ──────────────────────────────────────── */}
      <Card style={styles.Card}>
        <Card.Title title="Select File" />
        <Card.Content>
          <Text variant="bodyMedium" style={styles.HelpText}>
            Select an XLS, XLSX, or CSV file in Purple Skies export format.
          </Text>
          <Button
            mode="contained"
            icon="file-import-outline"
            loading={State === 'parsing'}
            disabled={State === 'parsing' || State === 'importing'}
            onPress={handlePickFile}
            style={styles.Button}
          >
            {Summary ? 'Pick a different file' : 'Pick file…'}
          </Button>
          {!!ParseError && <HelperText type="error" visible>{ParseError}</HelperText>}
        </Card.Content>
      </Card>

      {/* ── Step 2: summary + errors ───────────────────────────────── */}
      {Summary && (
        <Card style={styles.Card}>
          <Card.Title title={`${Summary.year} Season Preview`} />
          <Card.Content>
            <View style={styles.ChipRow}>
              <Chip icon="calendar-check" style={styles.Chip}>{Summary.check_dates.length} check dates</Chip>
              <Chip icon="home-outline" style={styles.Chip}>{Summary.rows.length} compartment rows</Chip>
              <Chip icon="check-circle-outline" style={styles.Chip}>{okChecks} valid entries</Chip>
              {errorCount > 0 && (
                <Chip icon="alert-circle-outline" style={[styles.Chip, styles.ChipError]}>{errorCount} errors</Chip>
              )}
            </View>

            {errorCount > 0 && (
              <>
                <Divider style={styles.Divider} />
                <Text variant="titleSmall" style={styles.ErrorHeading}>Errors</Text>
                {Summary.errors.map((err, i) => (
                  <List.Item
                    key={i}
                    title={err.raw}
                    description={`Row ${err.row} · ${err.date} · ${err.reason}`}
                    titleStyle={styles.ErrorTitle}
                    left={p => <List.Icon {...p} icon="alert-circle" color="red" />}
                    style={styles.ErrorItem}
                  />
                ))}
                <Button
                  mode="outlined"
                  icon="download"
                  onPress={handleDownloadErrors}
                  style={styles.Button}
                >
                  Download correction sheet
                </Button>
                <HelperText type="info" visible>
                  Fix the highlighted cells and re-import, or tap "Import (skip errors)" to import valid entries only.
                </HelperText>
              </>
            )}
          </Card.Content>
        </Card>
      )}

      {/* ── Step 3: import actions ─────────────────────────────────── */}
      {Summary && State !== 'done' && (
        <Card style={styles.Card}>
          <Card.Content>
            {!!ImportError2 && <HelperText type="error" visible>{ImportError2}</HelperText>}
            {errorCount === 0 ? (
              <Button
                mode="contained"
                icon="database-import"
                loading={State === 'importing'}
                disabled={State === 'importing'}
                onPress={() => runImport(false)}
                style={styles.Button}
              >
                Import {okChecks} entries
              </Button>
            ) : (
              <>
                <Button
                  mode="contained"
                  icon="database-import"
                  loading={State === 'importing'}
                  disabled={State === 'importing' || okChecks === 0}
                  onPress={() => runImport(true)}
                  style={styles.Button}
                >
                  Import {okChecks} valid entries (skip {errorCount} errors)
                </Button>
                <Button
                  mode="outlined"
                  icon="close"
                  disabled={State === 'importing'}
                  onPress={() => navigation.goBack()}
                  style={styles.Button}
                >
                  Cancel
                </Button>
              </>
            )}
          </Card.Content>
        </Card>
      )}

    </ScrollView>
  );
}

function housingTypeName(code: string): string {
  const names: Record<string, string> = {
    WH: 'Wooden House', MH: 'Metal House', PH: 'Plastic House',
    NG: 'Natural Gourd Rack', AG: 'Artificial Gourd Rack',
  };
  return names[code.toUpperCase()] ?? code;
}

const styles = StyleSheet.create({
  Container:    { padding: 16 },
  Card:         { marginBottom: 16 },
  Button:       { marginTop: 8 },
  HelpText:     { marginBottom: 8, color: '#555' },
  ChipRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  Chip:         { marginBottom: 4 },
  ChipError:    { backgroundColor: '#FFDDDD' },
  Divider:      { marginVertical: 12 },
  ErrorHeading: { marginBottom: 4 },
  ErrorTitle:   { color: 'red', fontWeight: 'bold' },
  ErrorItem:    { paddingLeft: 0 },
});
