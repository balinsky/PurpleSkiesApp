import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, Dialog, Divider, HelperText, List, Portal, Text, TextInput } from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { friendlyError } from '../lib/errorUtils';
import { AppStackParamList } from '../App';

type SiteSeason = {
  id: string;
  year: number;
};

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'SiteDetail'>;
  route: RouteProp<AppStackParamList, 'SiteDetail'>;
};

export default function SiteDetailScreen({ navigation, route }: Props) {
  const { SiteId, SiteName } = route.params;

  const [SiteSeasons, setSiteSeasons]                 = useState<SiteSeason[]>([]);
  const [StartingSeasonLoading, setStartingSeasonLoading] = useState(false);
  const [OtherSeasonVisible, setOtherSeasonVisible]       = useState(false);
  const [OtherSeasonYear, setOtherSeasonYear]             = useState('');
  const [OtherSeasonLoading, setOtherSeasonLoading]       = useState(false);
  const [OtherSeasonError, setOtherSeasonError]           = useState('');
  const [DeleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [Deleting, setDeleting]                       = useState(false);
  const [DeleteError, setDeleteError]                 = useState('');
  const [SiteDetailsExpanded, setSiteDetailsExpanded] = useState(false);
  const [DangerZoneExpanded, setDangerZoneExpanded]   = useState(false);
  const [UserRole, setUserRole]                       = useState<'owner' | 'manager' | 'collector' | 'viewer' | null>(null);

  // ── Edit site ──────────────────────────────────────────────────────
  const [EditVisible, setEditVisible]           = useState(false);
  const [EditName, setEditName]                 = useState('');
  const [EditAddress, setEditAddress]           = useState('');
  const [EditContactName, setEditContactName]   = useState('');
  const [EditContactEmail, setEditContactEmail] = useState('');
  const [EditContactPhone, setEditContactPhone] = useState('');
  const [EditContactAddr, setEditContactAddr]   = useState('');
  const [EditContactCity, setEditContactCity]   = useState('');
  const [EditContactState, setEditContactState] = useState('');
  const [EditContactZip, setEditContactZip]     = useState('');
  const [EditLoading, setEditLoading]           = useState(false);
  const [EditFetching, setEditFetching]         = useState(false);
  const [EditError, setEditError]               = useState('');

  useEffect(() => {
    async function loadRole() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: S } = await supabase.from('sites').select('owner_id').eq('id', SiteId).single();
      if (S?.owner_id === user.id) { setUserRole('owner'); return; }
      const { data: Mb } = await supabase
        .from('site_members').select('role').eq('site_id', SiteId).eq('user_id', user.id).maybeSingle();
      setUserRole((Mb?.role as any) ?? 'viewer');
    }
    loadRole();
  }, [SiteId]);

  useFocusEffect(
    useCallback(() => {
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

  async function handleOpenOtherSeason() {
    const Yr = parseInt(OtherSeasonYear.trim(), 10);
    if (isNaN(Yr) || OtherSeasonYear.trim().length !== 4) {
      setOtherSeasonError('Enter a valid 4-digit year.');
      return;
    }
    if (Yr < 1990 || Yr > CurrentYear) {
      setOtherSeasonError(`Year must be between 1990 and ${CurrentYear}.`);
      return;
    }
    setOtherSeasonLoading(true);
    setOtherSeasonError('');
    const { data: existing } = await supabase
      .from('site_seasons')
      .select('id')
      .eq('site_id', SiteId)
      .eq('year', Yr)
      .maybeSingle();
    if (existing) {
      setOtherSeasonLoading(false);
      setOtherSeasonVisible(false);
      navigation.navigate('SeasonDetail', { SeasonId: existing.id, SiteId, Year: Yr });
      return;
    }
    const { data, error } = await supabase
      .from('site_seasons')
      .insert({ site_id: SiteId, year: Yr })
      .select()
      .single();
    setOtherSeasonLoading(false);
    if (error) { setOtherSeasonError(friendlyError(error, 'Failed to create season.')); return; }
    if (data) {
      setOtherSeasonVisible(false);
      navigation.navigate('SeasonDetail', { SeasonId: data.id, SiteId, Year: Yr });
    }
  }

  // ── Edit site handlers ─────────────────────────────────────────────
  async function openEditSite() {
    setEditError('');
    setEditFetching(true);
    setEditVisible(true);
    const { data } = await supabase
      .from('sites')
      .select('name, address, contact_name, contact_email, contact_phone, contact_address, contact_city, contact_state, contact_zip')
      .eq('id', SiteId)
      .single();
    setEditFetching(false);
    if (data) {
      setEditName(data.name ?? '');
      setEditAddress(data.address ?? '');
      setEditContactName(data.contact_name ?? '');
      setEditContactEmail(data.contact_email ?? '');
      setEditContactPhone(data.contact_phone ?? '');
      setEditContactAddr(data.contact_address ?? '');
      setEditContactCity(data.contact_city ?? '');
      setEditContactState(data.contact_state ?? '');
      setEditContactZip(data.contact_zip ?? '');
    }
  }

  async function handleSaveSite() {
    if (!EditName.trim()) { setEditError('Please enter a name.'); return; }
    setEditLoading(true);
    const { error } = await supabase
      .from('sites')
      .update({
        name:            EditName.trim(),
        address:         EditAddress.trim()      || null,
        contact_name:    EditContactName.trim()  || null,
        contact_email:   EditContactEmail.trim() || null,
        contact_phone:   EditContactPhone.trim() || null,
        contact_address: EditContactAddr.trim()  || null,
        contact_city:    EditContactCity.trim()  || null,
        contact_state:   EditContactState.trim() || null,
        contact_zip:     EditContactZip.trim()   || null,
      })
      .eq('id', SiteId);
    setEditLoading(false);
    if (error) { setEditError(friendlyError(error)); return; }
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
      setDeleteError(friendlyError(error, 'Failed to delete site.'));
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

        {/* ── Site Details (collapsible) ─────────────────────────── */}
        <Button
          mode="text"
          compact
          icon={SiteDetailsExpanded ? 'chevron-up' : 'chevron-down'}
          contentStyle={styles.ExpandBtnContent}
          onPress={() => setSiteDetailsExpanded(!SiteDetailsExpanded)}
          style={styles.ExpandBtn}
        >
          Site Details
        </Button>
        {SiteDetailsExpanded && (UserRole === 'owner' || UserRole === 'manager') && (
          <View style={styles.SiteActions}>
            <Button mode="outlined" compact onPress={openEditSite}>
              Edit site name &amp; location
            </Button>
          </View>
        )}

        <Divider style={styles.Divider} />

        {/* ── Members ───────────────────────────────────────────────── */}
        <Button
          mode="text"
          compact
          icon="account-group-outline"
          contentStyle={styles.ExpandBtnContent}
          onPress={() => navigation.navigate('SiteMembers', { SiteId, SiteName })}
          style={styles.ExpandBtn}
        >
          Members
        </Button>

        <Divider style={styles.Divider} />

        {/* ── Seasons (always visible) ───────────────────────────── */}
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
            <Button
              mode="outlined"
              style={styles.SectionButton}
              loading={StartingSeasonLoading}
              onPress={handleStartSeason}
            >
              Start {CurrentYear} Season
            </Button>
          )}
          <Button
            mode="outlined"
            style={styles.SectionButton}
            icon="calendar-plus"
            onPress={() => { setOtherSeasonYear(''); setOtherSeasonError(''); setOtherSeasonVisible(true); }}
          >
            Enter data for another year
          </Button>
          <Button
            mode="outlined"
            style={styles.SectionButton}
            icon="file-import-outline"
            onPress={() => navigation.navigate('ImportSeason', { SiteId, SiteName })}
          >
            Import season from file
          </Button>
        </List.Section>

        <Divider style={styles.Divider} />

        {/* ── Danger zone (owner only, collapsible) ─────────────── */}
        {UserRole === 'owner' && <Button
          mode="text"
          compact
          textColor="red"
          icon={DangerZoneExpanded ? 'chevron-up' : 'chevron-down'}
          contentStyle={styles.ExpandBtnContent}
          onPress={() => setDangerZoneExpanded(!DangerZoneExpanded)}
          style={styles.ExpandBtn}
        >
          Danger zone
        </Button>}
        {DangerZoneExpanded && (
          <View style={styles.DangerActions}>
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
        )}

      </ScrollView>

      <Portal>
        {/* ── Edit Site ──────────────────────────────────────────── */}
        <Dialog visible={EditVisible} onDismiss={() => setEditVisible(false)}>
          <Dialog.Title>Edit Site</Dialog.Title>
          <Dialog.ScrollArea style={styles.DialogScroll}>
            {EditFetching ? (
              <Text style={styles.DialogLoadingText}>Loading…</Text>
            ) : (
              <ScrollView keyboardShouldPersistTaps="handled">
                <TextInput
                  label="Site name *"
                  value={EditName}
                  onChangeText={setEditName}
                  maxLength={100}
                  style={styles.DialogInput}
                />
                <TextInput
                  label="Site location"
                  value={EditAddress}
                  onChangeText={setEditAddress}
                  placeholder="Address or description of where the housing is"
                  multiline
                  maxLength={200}
                  style={styles.DialogInput}
                />
                <HelperText type="info" visible>
                  Can be an address or a description, e.g. "East field behind the gymnasium."
                </HelperText>
                <Text variant="titleSmall" style={styles.DialogSectionLabel}>Contact Information</Text>
                <TextInput
                  label="Housing provider name"
                  value={EditContactName}
                  onChangeText={setEditContactName}
                  maxLength={100}
                  style={styles.DialogInput}
                />
                <TextInput
                  label="Email"
                  value={EditContactEmail}
                  onChangeText={setEditContactEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  maxLength={200}
                  style={styles.DialogInput}
                />
                <TextInput
                  label="Phone"
                  value={EditContactPhone}
                  onChangeText={setEditContactPhone}
                  keyboardType="phone-pad"
                  maxLength={20}
                  style={styles.DialogInput}
                />
                <TextInput
                  label="Address"
                  value={EditContactAddr}
                  onChangeText={setEditContactAddr}
                  maxLength={200}
                  style={styles.DialogInput}
                />
                <TextInput
                  label="City"
                  value={EditContactCity}
                  onChangeText={setEditContactCity}
                  maxLength={100}
                  style={styles.DialogInput}
                />
                <TextInput
                  label="State"
                  value={EditContactState}
                  onChangeText={setEditContactState}
                  maxLength={50}
                  style={styles.DialogInput}
                />
                <TextInput
                  label="Zip"
                  value={EditContactZip}
                  onChangeText={setEditContactZip}
                  keyboardType="number-pad"
                  maxLength={10}
                  style={styles.DialogInput}
                />
                {EditError ? <HelperText type="error" visible>{EditError}</HelperText> : null}
              </ScrollView>
            )}
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setEditVisible(false)}>Cancel</Button>
            <Button loading={EditLoading} disabled={EditFetching} onPress={handleSaveSite}>Save</Button>
          </Dialog.Actions>
        </Dialog>

        {/* ── Other Season ───────────────────────────────────────── */}
        <Dialog visible={OtherSeasonVisible} onDismiss={() => setOtherSeasonVisible(false)}>
          <Dialog.Title>Open Another Season</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Year"
              value={OtherSeasonYear}
              onChangeText={v => { setOtherSeasonYear(v); setOtherSeasonError(''); }}
              keyboardType="number-pad"
              maxLength={4}
              autoFocus
            />
            {OtherSeasonError ? (
              <HelperText type="error" visible>{OtherSeasonError}</HelperText>
            ) : (
              <HelperText type="info" visible>
                Enter a year from 1990 to {CurrentYear}. A new season will be created if it doesn't exist.
              </HelperText>
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setOtherSeasonVisible(false)}>Cancel</Button>
            <Button loading={OtherSeasonLoading} disabled={OtherSeasonLoading} onPress={handleOpenOtherSeason}>Open</Button>
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
  Container:      { padding: 16 },
  ExpandBtn:      { alignSelf: 'flex-start', marginTop: 8 },
  ExpandBtnContent: { flexDirection: 'row-reverse' },
  SiteActions:    { marginBottom: 8, marginTop: 4 },
  Card:           { marginHorizontal: 16, marginBottom: 8 },
  SectionButton:  { marginHorizontal: 16, marginTop: 4, marginBottom: 8 },
  Divider:        { marginTop: 8 },
  DangerActions:  { marginTop: 8, marginBottom: 8 },
  DeleteButton:   { alignSelf: 'flex-start', borderColor: 'red' },
  ErrorText:          { color: 'red', marginTop: 8 },
  DialogScroll:       { maxHeight: 480 },
  DialogLoadingText:  { padding: 8 },
  DialogSectionLabel: { marginTop: 12, marginBottom: 8 },
  DialogInput:        { marginBottom: 8 },
});
