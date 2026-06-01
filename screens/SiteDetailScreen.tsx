import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, Dialog, Divider, HelperText, List, Portal, Text, TextInput } from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { AppStackParamList } from '../App';

type HousingUnit = {
  id: string;
  name: string;
  unit_type: string;
  default_hole_type: string | null;
};

type SiteSeason = {
  id: string;
  year: number;
};

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'SiteDetail'>;
  route: RouteProp<AppStackParamList, 'SiteDetail'>;
};

const UnitTypeLabel: Record<string, string> = {
  metal_house:   'Metal House',
  plastic_house: 'Plastic House',
  wooden_house:  'Wooden House',
  gourd_rack:    'Gourd Rack',
};

export default function SiteDetailScreen({ navigation, route }: Props) {
  const { SiteId, SiteName } = route.params;

  const [HousingUnits, setHousingUnits]               = useState<HousingUnit[]>([]);
  const [SiteSeasons, setSiteSeasons]                 = useState<SiteSeason[]>([]);
  const [StartingSeasonLoading, setStartingSeasonLoading] = useState(false);
  const [DeleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [Deleting, setDeleting]                       = useState(false);
  const [DeleteError, setDeleteError]                 = useState('');

  // ── Edit site ──────────────────────────────────────────────────────
  const [EditVisible, setEditVisible]   = useState(false);
  const [EditName, setEditName]         = useState('');
  const [EditAddress, setEditAddress]   = useState('');
  const [EditLoading, setEditLoading]   = useState(false);
  const [EditFetching, setEditFetching] = useState(false);
  const [EditError, setEditError]       = useState('');

  useFocusEffect(
    useCallback(() => {
      supabase
        .from('housing_units')
        .select('id, name, unit_type, default_hole_type')
        .eq('site_id', SiteId)
        .order('name')
        .then(({ data }) => setHousingUnits(data ?? []));

      supabase
        .from('site_seasons')
        .select('id, year')
        .eq('site_id', SiteId)
        .order('year', { ascending: false })
        .then(({ data }) => setSiteSeasons(data ?? []));
    }, [SiteId])
  );

  // ── Season handlers ────────────────────────────────────────────────
  async function handleStartSeason() {
    const CurrentYear = new Date().getFullYear();
    setStartingSeasonLoading(true);

    // Navigate if the season already exists
    const { data: existing } = await supabase
      .from('site_seasons')
      .select('id')
      .eq('site_id', SiteId)
      .eq('year', CurrentYear)
      .maybeSingle();

    if (existing) {
      setStartingSeasonLoading(false);
      navigation.navigate('SeasonDetail', { SeasonId: existing.id, SiteId, Year: CurrentYear });
      return;
    }

    const { data, error } = await supabase
      .from('site_seasons')
      .insert({ site_id: SiteId, year: CurrentYear })
      .select()
      .single();

    setStartingSeasonLoading(false);
    if (data) {
      navigation.navigate('SeasonDetail', { SeasonId: data.id, SiteId, Year: CurrentYear });
    }
  }

  // ── Edit site handlers ─────────────────────────────────────────────
  async function openEditSite() {
    setEditError('');
    setEditFetching(true);
    setEditVisible(true);
    const { data } = await supabase
      .from('sites')
      .select('name, address')
      .eq('id', SiteId)
      .single();
    setEditFetching(false);
    if (data) {
      setEditName(data.name ?? '');
      setEditAddress(data.address ?? '');
    }
  }

  async function handleSaveSite() {
    if (!EditName.trim()) { setEditError('Please enter a name.'); return; }
    setEditLoading(true);
    const { error } = await supabase
      .from('sites')
      .update({ name: EditName.trim(), address: EditAddress.trim() || null })
      .eq('id', SiteId);
    setEditLoading(false);
    if (error) { setEditError(error.message); return; }
    setEditVisible(false);
    navigation.setParams({ SiteName: EditName.trim() });
  }

  // ── Delete site handler ────────────────────────────────────────────
  async function handleDelete() {
    setDeleting(true);
    setDeleteError('');
    const { error } = await supabase.from('sites').delete().eq('id', SiteId);
    setDeleting(false);
    if (error) {
      setDeleteError(error.message);
    } else {
      setDeleteDialogVisible(false);
      navigation.goBack();
    }
  }

  const CurrentYear = new Date().getFullYear();
  const HasCurrentSeason = SiteSeasons.some((S) => S.year === CurrentYear);

  return (
    <>
      <ScrollView contentContainerStyle={styles.Container}>

        <View style={styles.SiteActions}>
          <Button mode="outlined" compact onPress={openEditSite}>
            Edit site name &amp; location
          </Button>
        </View>

        <List.Section>
          <List.Subheader>Housing Units</List.Subheader>
          {HousingUnits.length === 0 ? (
            <List.Item
              title="No housing units yet"
              description="Add a house or gourd rack to get started"
              left={(props) => <List.Icon {...props} icon="home-outline" />}
            />
          ) : (
            HousingUnits.map((Unit) => (
              <Card
                key={Unit.id}
                style={styles.Card}
                mode="outlined"
                onPress={() => navigation.navigate('HousingUnitDetail', {
                  UnitId:          Unit.id,
                  UnitName:        Unit.name,
                  UnitType:        Unit.unit_type,
                  DefaultHoleType: Unit.default_hole_type,
                })}
              >
                <Card.Title
                  title={Unit.name}
                  subtitle={UnitTypeLabel[Unit.unit_type] ?? Unit.unit_type}
                />
              </Card>
            ))
          )}
          <Button
            mode="outlined"
            style={styles.SectionButton}
            onPress={() => navigation.navigate('CreateHousingUnit', { SiteId })}
          >
            Add Housing Unit
          </Button>
        </List.Section>

        <Divider />

        <List.Section>
          <List.Subheader>Seasons</List.Subheader>
          {SiteSeasons.length === 0 ? (
            <List.Item
              title="No seasons yet"
              description="Tap below to start tracking this season"
              left={(props) => <List.Icon {...props} icon="calendar-outline" />}
            />
          ) : (
            SiteSeasons.map((Season) => (
              <Card
                key={Season.id}
                style={styles.Card}
                mode="outlined"
                onPress={() => navigation.navigate('SeasonDetail', {
                  SeasonId: Season.id,
                  SiteId,
                  Year: Season.year,
                })}
              >
                <Card.Title
                  title={`${Season.year} Season`}
                  left={(props) => <List.Icon {...props} icon="calendar" />}
                />
              </Card>
            ))
          )}
          {!HasCurrentSeason && (
            HousingUnits.length === 0 ? (
              <HelperText type="info" visible style={styles.SectionButton}>
                Add at least one housing unit before starting a season.
              </HelperText>
            ) : (
              <Button
                mode="outlined"
                style={styles.SectionButton}
                loading={StartingSeasonLoading}
                onPress={handleStartSeason}
              >
                Start {CurrentYear} Season
              </Button>
            )
          )}
        </List.Section>

        <Divider />

        <View style={styles.DangerZone}>
          <Text variant="labelLarge" style={styles.DangerLabel}>Danger zone</Text>
          <Button
            mode="outlined"
            textColor="red"
            style={styles.DeleteButton}
            onPress={() => setDeleteDialogVisible(true)}
          >
            Delete this site
          </Button>
          {DeleteError ? <Text style={styles.ErrorText}>{DeleteError}</Text> : null}
        </View>

      </ScrollView>

      <Portal>
        {/* ── Edit Site ──────────────────────────────────────────── */}
        <Dialog visible={EditVisible} onDismiss={() => setEditVisible(false)}>
          <Dialog.Title>Edit Site</Dialog.Title>
          <Dialog.Content>
            {EditFetching ? (
              <Text>Loading…</Text>
            ) : (
              <>
                <TextInput
                  label="Site name *"
                  value={EditName}
                  onChangeText={setEditName}
                  style={styles.DialogInput}
                />
                <TextInput
                  label="Site location"
                  value={EditAddress}
                  onChangeText={setEditAddress}
                  placeholder="Address or description of where the housing is"
                  multiline
                  style={styles.DialogInput}
                />
                <HelperText type="info" visible>
                  Can be an address or a description, e.g. "East field behind the gymnasium."
                </HelperText>
                {EditError ? <HelperText type="error" visible>{EditError}</HelperText> : null}
              </>
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setEditVisible(false)}>Cancel</Button>
            <Button loading={EditLoading} disabled={EditFetching} onPress={handleSaveSite}>Save</Button>
          </Dialog.Actions>
        </Dialog>

        {/* ── Delete Site ────────────────────────────────────────── */}
        <Dialog visible={DeleteDialogVisible} onDismiss={() => setDeleteDialogVisible(false)}>
          <Dialog.Title>Delete {SiteName}?</Dialog.Title>
          <Dialog.Content>
            <Text>
              This will permanently delete the site and all of its housing units, compartments,
              nest checks, and season data. This cannot be undone.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteDialogVisible(false)}>Cancel</Button>
            <Button textColor="red" loading={Deleting} onPress={handleDelete}>Delete</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  Container:     { padding: 16 },
  SiteActions:   { marginBottom: 8 },
  Card:          { marginHorizontal: 16, marginBottom: 8 },
  SectionButton: { marginHorizontal: 16, marginTop: 4, marginBottom: 8 },
  DangerZone:    { marginTop: 24, padding: 16 },
  DangerLabel:   { color: 'red', marginBottom: 12 },
  DeleteButton:  { borderColor: 'red' },
  ErrorText:     { color: 'red', marginTop: 8 },
  DialogInput:   { marginBottom: 8 },
});
