import React, { useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Button, Card, Chip, DataTable, Dialog, Divider, HelperText, List, Portal, Text } from 'react-native-paper';
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
  ImportSummary, ImportRow, ImportError, ImportEntryData, ParseCodeOk,
} from '../lib/importXls';
import { calcTotalEggsLaid } from '../lib/nestLogic';

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'ImportSeason'>;
  route: RouteProp<AppStackParamList, 'ImportSeason'>;
};

type ImportState = 'idle' | 'parsing' | 'ready' | 'reviewing' | 'importing' | 'done';

type RowStats = {
  rowIndex: number;
  label: string;
  calcEggs: number;
  statedEggs: number | null;
  calcHatch: number;
  statedHatch: number | null;
  calcFledge: number;
  statedFledge: number | null;
};

type OverrideField = 'eggs' | 'hatch' | 'fledge';
type RowOverrides = { eggs?: number; hatch?: number; fledge?: number };

// ── Pure helpers (outside component) ─────────────────────────────────────────

function calcFledgeFromChecks(
  checks: Array<{ date: string; data: ImportEntryData }>,
): number {
  let total = 0;
  for (let i = 1; i < checks.length; i++) {
    const { date: prevDate, data: prev } = checks[i - 1];
    const { date: currDate, data: curr } = checks[i];
    if (prev.is_empty_cavity || prev.young_count <= 0) continue;

    // Determine nestling age at the current check date.
    // If current check still has young with a recorded age, use it directly.
    // Otherwise project forward from the previous check's recorded age.
    let ageAtCurr: number | null = null;
    if (!curr.is_empty_cavity && curr.nestling_age_days != null && curr.young_count > 0) {
      ageAtCurr = curr.nestling_age_days;
    } else if (prev.nestling_age_days != null) {
      const elapsed = Math.round(
        (new Date(currDate).getTime() - new Date(prevDate).getTime()) / 86400000,
      );
      ageAtCurr = prev.nestling_age_days + elapsed;
    }
    if (ageAtCurr == null || ageAtCurr < 26) continue;

    const currYoung  = curr.is_empty_cavity ? 0 : curr.young_count;
    const drop       = prev.young_count - currYoung;
    if (drop <= 0) continue;

    const deadYoung = curr.is_empty_cavity ? 0 : curr.dead_young_count;
    total += Math.max(0, drop - deadYoung);
  }

  // If the final check still has young old enough to have fledged, count them.
  if (checks.length > 0) {
    const { data: last } = checks[checks.length - 1];
    if (!last.is_empty_cavity && last.young_count > 0 &&
        last.nestling_age_days != null && last.nestling_age_days >= 26) {
      total += last.young_count;
    }
  }
  return total;
}

function computeRowStats(summary: ImportSummary): RowStats[] {
  return summary.rows.map(Row => {
    const okChecks = Row.checks
      .filter(c => c.result.ok)
      .map(c => ({ date: c.date, data: (c.result as ParseCodeOk).data }));
    const okData = okChecks.map(c => c.data);
    const calcEggs  = calcTotalEggsLaid(okData);
    const calcHatch = Math.max(0, ...okData.map(c => c.young_count), 0);
    const calcFledge = calcFledgeFromChecks(okChecks);
    const label = Row.cavity_label + (Row.nesting_attempt > 1 ? ' (RA)' : '');
    return {
      rowIndex: Row.rowIndex, label,
      calcEggs,   statedEggs:   Row.stated_eggs,
      calcHatch,  statedHatch:  Row.stated_hatch,
      calcFledge, statedFledge: Row.stated_fledge,
    };
  });
}

function statCellInfo(
  calc: number,
  stated: number | null,
  override?: number,
): { display: string; discrepant: boolean; resolved: boolean } {
  if (override != null) {
    return { display: String(override), discrepant: override !== calc, resolved: true };
  }
  if (stated == null) return { display: String(calc), discrepant: false, resolved: false };
  if (stated === calc)  return { display: String(stated), discrepant: false, resolved: false };
  return { display: `${stated} / ${calc}`, discrepant: true, resolved: false };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ImportSeasonScreen({ navigation, route }: Props) {
  const { SiteId, SiteName } = route.params;
  const { syncNow } = useSync();

  const [State, setState]           = useState<ImportState>('idle');
  const [ParseError, setParseError] = useState('');
  const [FileUri, setFileUri]       = useState<string | null>(null);
  const [Summary, setSummary]       = useState<ImportSummary | null>(null);
  const [ImportError2, setImportError2] = useState('');

  // Review state
  const [ReviewStats, setReviewStats] = useState<RowStats[]>([]);
  const [Overrides, setOverrides]     = useState<Map<number, RowOverrides>>(new Map());
  const [EditTarget, setEditTarget]   = useState<{ rowIndex: number; field: OverrideField; label: string } | null>(null);
  const [EditValue, setEditValue]     = useState('');

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
      // Warn if "Total # Eggs Laid" (app-calculated at export time) disagrees with "Egg #" (user-stated)
      const eggMismatches = parsed.rows.filter(
        r => r.total_eggs_laid != null && r.stated_eggs != null && r.total_eggs_laid !== r.stated_eggs,
      );
      if (eggMismatches.length > 0) {
        const labels = eggMismatches.map(r => r.cavity_label + (r.nesting_attempt > 1 ? ' (RA)' : '')).join(', ');
        const choice = await new Promise<'fix' | 'continue'>(resolve => {
          Alert.alert(
            'Egg count mismatch',
            `In ${eggMismatches.length === 1 ? '1 row' : `${eggMismatches.length} rows`} the "Total # Eggs Laid" column disagrees with the "Egg #" column (${labels}).\n\nFix your spreadsheet and re-import, or continue using the "Egg #" values.`,
            [
              { text: 'Fix spreadsheet', style: 'cancel', onPress: () => resolve('fix') },
              { text: 'Continue', style: 'default', onPress: () => resolve('continue') },
            ],
          );
        });
        if (choice === 'fix') { setState('idle'); return; }
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

  function handleStartReview() {
    if (!Summary) return;
    setReviewStats(computeRowStats(Summary));
    setOverrides(new Map());
    setState('reviewing');
  }

  function openEdit(rowIndex: number, field: OverrideField, label: string) {
    const ovr = Overrides.get(rowIndex) ?? {};
    const stats = ReviewStats.find(r => r.rowIndex === rowIndex)!;
    let current: number;
    if (field === 'eggs')       current = ovr.eggs   ?? stats.statedEggs   ?? stats.calcEggs;
    else if (field === 'hatch') current = ovr.hatch  ?? stats.statedHatch  ?? stats.calcHatch;
    else                        current = ovr.fledge ?? stats.statedFledge ?? stats.calcFledge;
    setEditValue(String(current));
    setEditTarget({ rowIndex, field, label });
  }

  function saveOverride() {
    if (!EditTarget) return;
    const n = parseInt(EditValue, 10);
    if (!isNaN(n) && n >= 0) {
      const m = new Map(Overrides);
      m.set(EditTarget.rowIndex, { ...(m.get(EditTarget.rowIndex) ?? {}), [EditTarget.field]: n });
      setOverrides(m);
    }
    setEditTarget(null);
  }

  async function runImport() {
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
        if (choice === 'cancel') { setState('reviewing'); return; }
        SeasonId = existing.id;
      } else {
        const { data: newSeason, error } = await supabase
          .from('site_seasons')
          .insert({ site_id: SiteId, year: Summary.year })
          .select('id')
          .single();
        if (error || !newSeason) {
          setImportError2('Failed to create season: ' + (error?.message ?? 'unknown error'));
          setState('reviewing');
          return;
        }
        SeasonId = newSeason.id;
      }

      // ── Housing units ──────────────────────────────────────────────
      const UnitMap = new Map<string, { id: string; unit_type: string }>();
      for (const Row of Summary.rows) {
        const unitName = Row.unit_name;
        if (!UnitMap.has(unitName)) {
          const unit_type = unitTypeFromHousingCode(Row.housing_type);
          const { data: existingUnit } = await supabase
            .from('housing_units')
            .select('id, unit_type')
            .eq('site_id', SiteId)
            .eq('site_season_id', SeasonId)
            .eq('name', unitName)
            .maybeSingle();

          if (existingUnit) {
            UnitMap.set(unitName, { id: existingUnit.id, unit_type: (existingUnit as any).unit_type ?? unit_type });
          } else {
            const holeCounts = new Map<string, number>();
            for (const R of Summary.rows) {
              if (R.unit_name === unitName && R.hole_type)
                holeCounts.set(R.hole_type, (holeCounts.get(R.hole_type) ?? 0) + 1);
            }
            const default_hole_type = holeCounts.size > 0
              ? [...holeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
              : null;
            const newId = makeId();
            const { error } = await supabase.from('housing_units').insert({
              id: newId, site_id: SiteId, site_season_id: SeasonId,
              name: unitName, unit_type, default_hole_type,
            });
            if (!error) UnitMap.set(unitName, { id: newId, unit_type });
          }
        }
      }

      await cacheUnitsAndCompartments(
        [...UnitMap.entries()].map(([name, { id }]) => ({ id, name, site_id: SiteId, site_season_id: SeasonId })),
        [],
      );

      // ── Compartments ───────────────────────────────────────────────
      const CompMap = new Map<string, string>();
      for (const Row of Summary.rows) {
        const unitName = Row.unit_name;
        const unit = UnitMap.get(unitName);
        if (!unit) continue;
        const compKey = `${unitName}:${Row.cavity_label}`;
        if (!CompMap.has(compKey)) {
          const { data: existingComp } = await supabase
            .from('compartments')
            .select('id')
            .eq('housing_unit_id', unit.id)
            .eq('cavity_label', Row.cavity_label)
            .maybeSingle();

          if (existingComp) {
            CompMap.set(compKey, existingComp.id);
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

      await cacheUnitsAndCompartments([], [...CompMap.entries()].map(([key, id]) => {
        const colonIdx = key.indexOf(':');
        const unitName = key.slice(0, colonIdx);
        const label    = key.slice(colonIdx + 1);
        const unit = UnitMap.get(unitName)!;
        return { id, housing_unit_id: unit.id, cavity_label: label, sort_order: null, site_season_id: SeasonId };
      }));

      // ── Nest checks ────────────────────────────────────────────────
      const { data: { user } } = await supabase.auth.getUser();
      const CheckMap = new Map<string, string>();

      for (const date of Summary.check_dates) {
        const { data: existingCheck } = await supabase
          .from('nest_checks')
          .select('id')
          .eq('site_id', SiteId)
          .eq('check_date', date)
          .maybeSingle();

        if (existingCheck) {
          CheckMap.set(date, existingCheck.id);
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

      // ── Nest check entries ─────────────────────────────────────────
      for (const Row of Summary.rows) {
        const compKey = `${Row.unit_name}:${Row.cavity_label}`;
        const CompId  = CompMap.get(compKey);
        if (!CompId) continue;

        // Determine effective fledge count for this row
        const ovr = Overrides.get(Row.rowIndex);
        let effectiveFledge: number;
        if (ovr?.fledge != null) {
          effectiveFledge = ovr.fledge;
        } else if (Row.stated_fledge != null) {
          effectiveFledge = Row.stated_fledge;
        } else {
          const okChecks = Row.checks.filter(c => c.result.ok).map(c => ({ date: c.date, data: (c.result as ParseCodeOk).data }));
          effectiveFledge = calcFledgeFromChecks(okChecks);
        }

        // Write fledge to the last valid check entry
        const validDates = Row.checks.filter(c => c.result.ok).map(c => c.date);
        const lastValidDate = validDates[validDates.length - 1] ?? null;

        for (const { date, result } of Row.checks) {
          if (!result.ok) continue;

          const CheckId = CheckMap.get(date);
          if (!CheckId) continue;

          const D = result.data;

          const { data: existingEntry } = await supabase
            .from('nest_check_entries')
            .select('id')
            .eq('nest_check_id', CheckId)
            .eq('compartment_id', CompId)
            .eq('nesting_attempt', Row.nesting_attempt)
            .maybeSingle();

          if (existingEntry) continue;

          const EntryId = makeId();
          const Payload = {
            id: EntryId, nest_check_id: CheckId, compartment_id: CompId,
            species: D.is_empty_cavity ? 'PM' : D.species,
            is_empty_cavity:     D.is_empty_cavity,
            has_nest:            D.has_nest,
            nest_discarded:      D.nest_discarded,
            nest_replaced:       false,
            adult_present:       false,
            egg_count:           D.egg_count,
            discarded_eggs:      D.discarded_eggs,
            young_count:         D.young_count,
            nestling_age_days:   D.nestling_age_days,
            nestling_age_notes:  null as null,
            dead_young_count:    D.dead_young_count,
            dead_adult_sex:      D.dead_adult_sex,
            fledged_count:       date === lastValidDate ? effectiveFledge : 0,
            renesting_attempt:   Row.nesting_attempt > 1,
            nesting_attempt:     Row.nesting_attempt,
            notes:               D.has_banding ? (D.notes ? `${D.notes} banded` : 'banded') : (D.notes ?? null),
            observed_male_age:   null as null,
            observed_female_age: null as null,
            gourd_removed:       D.gourd_removed,
          };

          await upsertLocalEntry(Payload);
          await supabase.from('nest_check_entries').upsert(Payload);
        }

        // ── nest_seasons (male/female age) ─────────────────────────
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
      setState('reviewing');
    }
  }

  const errorCount  = Summary?.errors.length ?? 0;
  const okChecks    = Summary ? Summary.rows.reduce((n, r) => n + r.checks.filter(c => c.result.ok).length, 0) : 0;
  const hasStatedCols = Summary?.rows.some(r => r.stated_eggs != null || r.stated_hatch != null || r.stated_fledge != null) ?? false;
  // Extract before JSX to avoid TypeScript narrowing inside conditional blocks
  const IsImporting = State === 'importing';
  const IsParsing   = State === 'parsing';

  return (
    <ScrollView contentContainerStyle={styles.Container} keyboardShouldPersistTaps="handled">

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
            loading={IsParsing}
            disabled={IsParsing || IsImporting}
            onPress={handlePickFile}
            style={styles.Button}
          >
            {Summary ? 'Pick a different file' : 'Pick file…'}
          </Button>
          {!!ParseError && <HelperText type="error" visible>{ParseError}</HelperText>}
        </Card.Content>
      </Card>

      {/* ── Step 2: summary + errors ───────────────────────────────── */}
      {Summary && State !== 'importing' && (
        <Card style={styles.Card}>
          <Card.Title title={`${Summary.year} Season Preview`} />
          <Card.Content>
            <View style={styles.ChipRow}>
              <Chip icon="calendar-check" style={styles.Chip}>{Summary.check_dates.length} check dates</Chip>
              <Chip icon="home-outline"   style={styles.Chip}>{Summary.rows.length} compartment rows</Chip>
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
                  Fix the highlighted cells and re-import, or proceed to review to import valid entries only.
                </HelperText>
              </>
            )}
          </Card.Content>
        </Card>
      )}

      {/* ── Step 3: proceed to review ─────────────────────────────── */}
      {Summary && State === 'ready' && (
        <Card style={styles.Card}>
          <Card.Content>
            {!!ImportError2 && <HelperText type="error" visible>{ImportError2}</HelperText>}
            <Button
              mode="contained"
              icon="table-check"
              onPress={handleStartReview}
              style={styles.Button}
            >
              Review & Import{errorCount > 0 ? ` (skip ${errorCount} errors)` : ''}
            </Button>
          </Card.Content>
        </Card>
      )}

      {/* ── Step 4: discrepancy review ─────────────────────────────── */}
      {Summary && State === 'reviewing' && (
        <Card style={styles.Card}>
          <Card.Title title="Review" />
          <Card.Content>
            <Text variant="bodySmall" style={styles.HelpText}>
              {hasStatedCols
                ? 'Discrepant cells show stated / calc. Tap to override.'
                : 'Calculated totals per nest. Tap to override before importing.'}
              {errorCount > 0 ? `  (${errorCount} errors will be skipped)` : ''}
            </Text>

            {!!ImportError2 && <HelperText type="error" visible>{ImportError2}</HelperText>}

            <DataTable>
              <DataTable.Header>
                <DataTable.Title style={styles.CavityCol}>Cavity</DataTable.Title>
                <DataTable.Title numeric style={styles.StatCol}>Eggs</DataTable.Title>
                <DataTable.Title numeric style={styles.StatCol}>Hatch</DataTable.Title>
                <DataTable.Title numeric style={styles.StatCol}>Fledge</DataTable.Title>
              </DataTable.Header>

              {ReviewStats.map(row => {
                const ovr = Overrides.get(row.rowIndex) ?? {};
                const eggs   = statCellInfo(row.calcEggs,   row.statedEggs,   ovr.eggs);
                const hatch  = statCellInfo(row.calcHatch,  row.statedHatch,  ovr.hatch);
                const fledge = statCellInfo(row.calcFledge, row.statedFledge, ovr.fledge);
                const eggBg   = eggs.resolved   ? styles.ResolvedCell   : eggs.discrepant   ? styles.DiscrepantCell   : undefined;
                const hatchBg = hatch.resolved  ? styles.ResolvedCell   : hatch.discrepant  ? styles.DiscrepantCell   : undefined;
                const fledgeBg = fledge.resolved ? styles.ResolvedCell  : fledge.discrepant ? styles.DiscrepantCell   : undefined;
                return (
                  <DataTable.Row key={row.rowIndex}>
                    <DataTable.Cell style={styles.CavityCol}>
                      <Text variant="bodySmall" numberOfLines={1}>{row.label}</Text>
                    </DataTable.Cell>
                    <DataTable.Cell numeric style={[styles.StatCol, eggBg]}>
                      <TouchableOpacity onPress={() => openEdit(row.rowIndex, 'eggs', row.label)}>
                        <Text variant="bodySmall">{eggs.display}</Text>
                      </TouchableOpacity>
                    </DataTable.Cell>
                    <DataTable.Cell numeric style={[styles.StatCol, hatchBg]}>
                      <TouchableOpacity onPress={() => openEdit(row.rowIndex, 'hatch', row.label)}>
                        <Text variant="bodySmall">{hatch.display}</Text>
                      </TouchableOpacity>
                    </DataTable.Cell>
                    <DataTable.Cell numeric style={[styles.StatCol, fledgeBg]}>
                      <TouchableOpacity onPress={() => openEdit(row.rowIndex, 'fledge', row.label)}>
                        <Text variant="bodySmall">{fledge.display}</Text>
                      </TouchableOpacity>
                    </DataTable.Cell>
                  </DataTable.Row>
                );
              })}
            </DataTable>

            <View style={styles.ButtonRow}>
              <Button
                mode="outlined"
                icon="arrow-left"
                onPress={() => setState('ready')}
                style={styles.FlexButton}
              >
                Back
              </Button>
              <Button
                mode="contained"
                icon="database-import"
                loading={IsImporting}
                disabled={IsImporting}
                onPress={runImport}
                style={styles.FlexButton}
              >
                Import
              </Button>
            </View>
          </Card.Content>
        </Card>
      )}

      {/* ── Override dialog ────────────────────────────────────────── */}
      <Portal>
        <Dialog visible={EditTarget != null} onDismiss={() => setEditTarget(null)}>
          <Dialog.Title>
            {EditTarget ? `Override ${EditTarget.field} — ${EditTarget.label}` : 'Override'}
          </Dialog.Title>
          <Dialog.Content>
            <TextInput
              value={EditValue}
              onChangeText={setEditValue}
              keyboardType="number-pad"
              style={styles.EditInput}
              autoFocus
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setEditTarget(null)}>Cancel</Button>
            <Button onPress={saveOverride}>OK</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

    </ScrollView>
  );
}

function unitTypeFromHousingCode(code: string): string {
  switch (code.toUpperCase()) {
    case 'WH': return 'wooden_house';
    case 'MH': return 'metal_house';
    case 'PH': return 'plastic_house';
    case 'AG': case 'NG': return 'gourd_rack';
    default:   return 'wooden_house';
  }
}

const styles = StyleSheet.create({
  Container:      { padding: 16 },
  Card:           { marginBottom: 16 },
  Button:         { marginTop: 8 },
  HelpText:       { marginBottom: 8, color: '#555' },
  ChipRow:        { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  Chip:           { marginBottom: 4 },
  ChipError:      { backgroundColor: '#FFDDDD' },
  Divider:        { marginVertical: 12 },
  ErrorHeading:   { marginBottom: 4 },
  ErrorTitle:     { color: 'red', fontWeight: 'bold' },
  ErrorItem:      { paddingLeft: 0 },
  CavityCol:      { flex: 2 },
  StatCol:        { flex: 1 },
  DiscrepantCell: { backgroundColor: '#FFD0D0' },
  ResolvedCell:   { backgroundColor: '#D0FFD0' },
  ButtonRow:      { flexDirection: 'row', gap: 8, marginTop: 12 },
  FlexButton:     { flex: 1 },
  EditInput:      { borderWidth: 1, borderColor: '#aaa', borderRadius: 4, padding: 8, fontSize: 18, marginTop: 4 },
});
