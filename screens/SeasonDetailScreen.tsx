import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Button, Card, Dialog, FAB, HelperText, List, Portal, Text, TextInput } from 'react-native-paper';
import DateInput from '../components/DateInput';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { AppStackParamList } from '../App';

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

function todayString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function SeasonDetailScreen({ navigation, route }: Props) {
  const { SeasonId, SiteId, Year } = route.params;

  const [FirstAsySeen, setFirstAsySeen]           = useState('');
  const [FirstSyMaleSeen, setFirstSyMaleSeen]     = useState('');
  const [DatesLoading, setDatesLoading]           = useState(false);
  const [DatesError, setDatesError]               = useState('');
  const [ArrivalDatesExpanded, setArrivalDatesExpanded] = useState(false);

  const [NestChecks, setNestChecks]   = useState<NestCheck[]>([]);
  const [ChecksLoading, setChecksLoading] = useState(true);

  // ── Add check dialog ───────────────────────────────────────────────
  const [AddCheckVisible, setAddCheckVisible]   = useState(false);
  const [NewCheckDate, setNewCheckDate]         = useState('');
  const [AddCheckLoading, setAddCheckLoading]   = useState(false);
  const [AddCheckError, setAddCheckError]       = useState('');

  useFocusEffect(
    useCallback(() => {
      supabase
        .from('site_seasons')
        .select('date_first_asy_seen, date_first_sy_male_seen')
        .eq('id', SeasonId)
        .single()
        .then(({ data }) => {
          if (data) {
            setFirstAsySeen(data.date_first_asy_seen ?? '');
            setFirstSyMaleSeen(data.date_first_sy_male_seen ?? '');
          }
        });

      supabase
        .from('nest_checks')
        .select('id, check_date')
        .eq('site_id', SiteId)
        .gte('check_date', `${Year}-01-01`)
        .lte('check_date', `${Year}-12-31`)
        .order('check_date', { ascending: true })
        .then(({ data }) => {
          setNestChecks(data ?? []);
          setChecksLoading(false);
        });
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

  return (
    <>
      <View style={styles.Container}>
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
  Container:     { flex: 1 },
  List:          { padding: 16, paddingBottom: 80 },
  SectionHeader:   { marginTop: 16, marginBottom: 4 },
  ExpandBtn:       { alignSelf: 'flex-start', marginTop: 8 },
  ExpandBtnContent:{ flexDirection: 'row-reverse' },
  Hint:          { color: '#666', marginBottom: 8 },
  Input:         { marginBottom: 8 },
  SaveDatesBtn:  { alignSelf: 'flex-start', marginBottom: 16 },
  Card:          { marginBottom: 8 },
  EmptyText:     { color: '#666', marginBottom: 16 },
  FAB:           { position: 'absolute', right: 16, bottom: 16 },
  DialogInput:   { marginBottom: 8 },
});
