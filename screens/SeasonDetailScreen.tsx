import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, Dialog, FAB, HelperText, IconButton, List, Portal, Text, TextInput } from 'react-native-paper';
import { Calendar } from 'react-native-calendars';
import DateInput from '../components/DateInput';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { AppStackParamList } from '../App';
import { useSettings } from '../contexts/SettingsContext';

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
};

function progressLine(P: CompartmentProgress): string {
  const AgeParts = [P.male_age && `♂ ${P.male_age}`, P.female_age && `♀ ${P.female_age}`].filter(Boolean).join('  ');
  const Age = AgeParts ? `  ·  ${AgeParts}` : '';
  if (P.actual_hatch) {
    const fledge = P.proj_fledge ? `  ·  Fledge ${shortDate(P.proj_fledge)}` : '';
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

export default function SeasonDetailScreen({ navigation, route }: Props) {
  const { SeasonId, SiteId, Year } = route.params;
  const { SeasonCalendarView, toggleSeasonCalendarView } = useSettings();

  const [FirstAsySeen, setFirstAsySeen]           = useState('');
  const [FirstSyMaleSeen, setFirstSyMaleSeen]     = useState('');
  const [DatesLoading, setDatesLoading]           = useState(false);
  const [DatesError, setDatesError]               = useState('');
  const [ArrivalDatesExpanded, setArrivalDatesExpanded] = useState(false);


  const [NestChecks, setNestChecks]       = useState<NestCheck[]>([]);
  const [ChecksLoading, setChecksLoading] = useState(true);
  const [NestProgress, setNestProgress]         = useState<CompartmentProgress[]>([]);
  const [NestProgressExpanded, setNestProgressExpanded] = useState(false);

  // ── Add check dialog ───────────────────────────────────────────────
  const [AddCheckVisible, setAddCheckVisible]   = useState(false);
  const [NewCheckDate, setNewCheckDate]         = useState('');
  const [AddCheckLoading, setAddCheckLoading]   = useState(false);
  const [AddCheckError, setAddCheckError]       = useState('');

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <IconButton
          icon={SeasonCalendarView ? 'format-list-bulleted' : 'calendar-month'}
          size={22}
          onPress={toggleSeasonCalendarView}
          style={{ marginRight: 4 }}
        />
      ),
    });
  }, [SeasonCalendarView]);

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

        // Nest check list
        const { data: Checks } = await supabase
          .from('nest_checks')
          .select('id, check_date')
          .eq('site_id', SiteId)
          .gte('check_date', `${Year}-01-01`)
          .lte('check_date', `${Year}-12-31`)
          .order('check_date', { ascending: true });
        setNestChecks(Checks ?? []);
        setChecksLoading(false);

        if (!Checks || Checks.length === 0) { setNestProgress([]); return; }

        // All PM entries for the season (for nest progress)
        const { data: Entries } = await supabase
          .from('nest_check_entries')
          .select('nest_check_id, compartment_id, egg_count, young_count, nestling_age_days, compartments(cavity_label, housing_units(name))')
          .in('nest_check_id', Checks.map(c => c.id))
          .eq('species', 'PM');

        if (!Entries) { setNestProgress([]); return; }

        // Adult ages per compartment for this season
        const { data: NestSeasonRows } = await supabase
          .from('nest_seasons')
          .select('compartment_id, male_age, female_age')
          .eq('site_season_id', SeasonId);
        const AgeMap = new Map<string, { male_age: string | null; female_age: string | null }>();
        if (NestSeasonRows) {
          for (const NS of NestSeasonRows) AgeMap.set(NS.compartment_id, NS);
        }

        // Group entries by compartment
        const CompMap = new Map<string, { label: string; unit_name: string; ewd: { check_date: string; egg_count: number; young_count: number; nestling_age_days: number | null }[] }>();
        for (const E of Entries) {
          const Chk = Checks.find(c => c.id === E.nest_check_id);
          if (!Chk) continue;
          const comp = E.compartments as any;
          if (!comp) continue;
          if (!CompMap.has(E.compartment_id)) {
            CompMap.set(E.compartment_id, {
              label:     comp.cavity_label as string,
              unit_name: (comp.housing_units as any)?.name as string ?? '',
              ewd:       [],
            });
          }
          CompMap.get(E.compartment_id)!.ewd.push({
            check_date:       Chk.check_date,
            egg_count:        E.egg_count ?? 0,
            young_count:      E.young_count ?? 0,
            nestling_age_days: E.nestling_age_days,
          });
        }

        // Compute projections per compartment
        const Progress: CompartmentProgress[] = [];
        for (const [CompId, Data] of CompMap) {
          if (!Data.ewd.some(e => e.egg_count > 0 || e.young_count > 0)) continue;

          const EWD = [...Data.ewd].sort((a, b) => a.check_date.localeCompare(b.check_date));
          let FirstEggMin: string | null = null, FirstEggMax: string | null = null;
          let ProjHatchMin: string | null = null, ProjHatchMax: string | null = null;
          let ActualHatch: string | null = null, ProjFledge: string | null = null;

          const FirstWithEggs = EWD.find(e => e.egg_count > 0);
          if (FirstWithEggs) {
            const LastEmpty    = [...EWD].filter(e => e.egg_count === 0 && e.check_date < FirstWithEggs.check_date).pop();
            const LatestFirst  = addDays(FirstWithEggs.check_date, -(FirstWithEggs.egg_count - 1));
            const EarliestFirst = LastEmpty ? addDays(LastEmpty.check_date, 1) : null;
            const MinFirst     = (EarliestFirst && EarliestFirst <= LatestFirst) ? EarliestFirst : LatestFirst;
            FirstEggMin = MinFirst; FirstEggMax = LatestFirst;
            const MaxEggs = Math.max(...EWD.map(e => e.egg_count));
            ProjHatchMin = addDays(MinFirst,    MaxEggs - 1 + 15);
            ProjHatchMax = addDays(LatestFirst, MaxEggs - 1 + 15);
          }

          const Anchor = EWD.find(e => e.young_count > 0 && (e.nestling_age_days ?? 0) > 0);
          if (Anchor) {
            const [ay, am, ad] = Anchor.check_date.split('-').map(Number);
            const Hatch = new Date(ay, am - 1, ad);
            Hatch.setDate(Hatch.getDate() - Anchor.nestling_age_days!);
            ActualHatch = `${Hatch.getFullYear()}-${String(Hatch.getMonth() + 1).padStart(2, '0')}-${String(Hatch.getDate()).padStart(2, '0')}`;
            ProjFledge  = addDays(ActualHatch, 26);
          }

          const Ages = AgeMap.get(CompId);
          Progress.push({ compartment_id: CompId, label: Data.label, unit_name: Data.unit_name, first_egg_min: FirstEggMin, first_egg_max: FirstEggMax, proj_hatch_min: ProjHatchMin, proj_hatch_max: ProjHatchMax, actual_hatch: ActualHatch, proj_fledge: ProjFledge, male_age: Ages?.male_age ?? null, female_age: Ages?.female_age ?? null });
        }

        setNestProgress(Progress.sort((a, b) => {
          const u = a.unit_name.localeCompare(b.unit_name);
          return u !== 0 ? u : a.label.localeCompare(b.label);
        }));
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
    if (error) setDatesError(error.message);
  }

  // ── Add nest check ─────────────────────────────────────────────────
  function openAddCheck() {
    setNewCheckDate(todayString());
    setAddCheckError('');
    setAddCheckVisible(true);
  }

  async function handleAddCheck() {
    const DateVal = NewCheckDate.trim();
    if (!DateVal) { setAddCheckError('Please enter a date.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(DateVal)) {
      setAddCheckError('Use YYYY-MM-DD format, e.g. 2026-06-01.');
      return;
    }
    setAddCheckLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: Check, error } = await supabase
      .from('nest_checks')
      .insert({ site_id: SiteId, check_date: DateVal, created_by: user!.id })
      .select()
      .single();
    setAddCheckLoading(false);
    if (error) { setAddCheckError(error.message); return; }
    setAddCheckVisible(false);
    navigation.navigate('NestCheckDetail', {
      CheckId:   Check.id,
      CheckDate: Check.check_date,
      SiteId,
      SeasonId,
      Year,
    });
  }

  const MarkedDates = Object.fromEntries(
    NestChecks.map(c => [c.check_date, { selected: true, selectedColor: '#7b1fa2' }])
  );
  const InitialDate = NestChecks.length > 0 ? NestChecks[0].check_date : undefined;

  return (
    <>
      <View style={styles.Container}>
        {SeasonCalendarView ? (
          <ScrollView contentContainerStyle={styles.CalendarScroll}>
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
                {NestProgressExpanded && NestProgress.map((P) => (
                  <View key={P.compartment_id} style={styles.ProgressRow}>
                    <Text style={styles.ProgressTitle}>{P.unit_name} · {P.label}</Text>
                    <Text style={styles.ProgressDates}>{progressLine(P)}</Text>
                  </View>
                ))}
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
                  {NestProgressExpanded && NestProgress.map((P) => (
                    <View key={P.compartment_id} style={styles.ProgressRow}>
                      <Text style={styles.ProgressTitle}>{P.unit_name} · {P.label}</Text>
                      <Text style={styles.ProgressDates}>{progressLine(P)}</Text>
                    </View>
                  ))}
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
          onPress={openAddCheck}
        />
      </View>

      <Portal>
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
});
