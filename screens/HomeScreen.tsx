import React, { useCallback, useState } from 'react';
import { Alert, FlatList, StyleSheet, View } from 'react-native';
import { Button, Card, FAB, Text } from 'react-native-paper';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { AppStackParamList } from '../App';

type Site = { id: string; name: string; address: string | null };

type PendingInvite = {
  id:         string;
  site_id:    string;
  site_name:  string;
  role:       string;
};

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'Home'>;
};

const RoleLabel: Record<string, string> = {
  manager:   'Manager',
  collector: 'Collector',
  viewer:    'Viewer',
};

export default function HomeScreen({ navigation }: Props) {
  const [Sites, setSites]               = useState<Site[]>([]);
  const [Loading, setLoading]           = useState(true);
  const [Invites, setInvites]           = useState<PendingInvite[]>([]);
  const [Accepting, setAccepting]       = useState<string | null>(null);
  const [Declining, setDeclining]       = useState<string | null>(null);


  useFocusEffect(
    useCallback(() => {
      loadAll();
    }, [])
  );

  async function loadAll() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    const email = user?.email?.toLowerCase() ?? '';

    const [{ data: SiteData }, { data: InvData }] = await Promise.all([
      supabase.from('sites').select('id, name, address').order('name'),
      email
        ? supabase.from('invitations')
            .select('id, site_id, role, site_name')
            .eq('invited_email', email)
            .is('accepted_at', null)
        : Promise.resolve({ data: [] as any[] }),
    ]);

    setSites(SiteData ?? []);

    const Pending: PendingInvite[] = (InvData ?? []).map((I: any) => ({
      id:        I.id,
      site_id:   I.site_id,
      site_name: I.site_name ?? 'Unknown site',
      role:      I.role,
    }));
    setInvites(Pending);
    setLoading(false);
  }

  async function handleAccept(Inv: PendingInvite) {
    setAccepting(Inv.id);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setAccepting(null); return; }
    const { error } = await supabase.from('site_members')
      .insert({ site_id: Inv.site_id, user_id: user.id, role: Inv.role });
    if (error) {
      setAccepting(null);
      Alert.alert('Could not join site', error.message);
      return;
    }
    await supabase.from('invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', Inv.id);
    setAccepting(null);
    loadAll();
  }

  async function handleDecline(Inv: PendingInvite) {
    setDeclining(Inv.id);
    await supabase.from('invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', Inv.id);
    setDeclining(null);
    setInvites(Prev => Prev.filter(I => I.id !== Inv.id));
  }

  const HasContent = Sites.length > 0 || Invites.length > 0;

  return (
    <View style={styles.Container}>
      {!Loading && !HasContent ? (
        <View style={styles.Empty}>
          <Text variant="titleMedium" style={styles.EmptyTitle}>No sites yet</Text>
          <Text variant="bodyMedium" style={styles.EmptyText}>
            Tap the + button to add your first Purple Martin housing site.
          </Text>
        </View>
      ) : (
        <FlatList
          data={Sites}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.List}
          ListHeaderComponent={Invites.length > 0 ? (
            <View style={styles.InvitesSection}>
              <Text variant="labelLarge" style={styles.InvitesHeader}>
                Pending Invitations
              </Text>
              {Invites.map((Inv) => (
                <Card key={Inv.id} style={styles.InviteCard} mode="contained">
                  <Card.Content style={styles.InviteContent}>
                    <View style={styles.InviteInfo}>
                      <Text variant="titleSmall">{Inv.site_name}</Text>
                      <Text variant="bodySmall" style={styles.InviteRole}>
                        Invited as {RoleLabel[Inv.role] ?? Inv.role}
                      </Text>
                    </View>
                    <View style={styles.InviteActions}>
                      <Button
                        mode="contained" compact
                        loading={Accepting === Inv.id}
                        disabled={!!Accepting || !!Declining}
                        onPress={() => handleAccept(Inv)}
                      >
                        Join
                      </Button>
                      <Button
                        mode="text" compact textColor="#616161"
                        loading={Declining === Inv.id}
                        disabled={!!Accepting || !!Declining}
                        onPress={() => handleDecline(Inv)}
                      >
                        Decline
                      </Button>
                    </View>
                  </Card.Content>
                </Card>
              ))}
            </View>
          ) : null}
          renderItem={({ item }) => (
            <Card
              style={styles.Card}
              mode="outlined"
              onPress={() => navigation.navigate('SiteDetail', { SiteId: item.id, SiteName: item.name })}
            >
              <Card.Title title={item.name} subtitle={item.address ?? 'No address set'} />
            </Card>
          )}
        />
      )}
      <FAB
        icon="plus"
        style={styles.FAB}
        onPress={() => navigation.navigate('CreateSite')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  Container:      { flex: 1 },
  List:           { padding: 16, paddingBottom: 80 },
  Card:           { marginBottom: 12 },
  Empty:          { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  EmptyTitle:     { marginBottom: 8 },
  EmptyText:      { textAlign: 'center', color: '#666' },
  FAB:            { position: 'absolute', right: 16, bottom: 16 },
  InvitesSection: { marginBottom: 16 },
  InvitesHeader:  { marginBottom: 8 },
  InviteCard:     { marginBottom: 8, backgroundColor: '#f3e8ff' },
  InviteContent:  { flexDirection: 'row', alignItems: 'center', gap: 12 },
  InviteInfo:     { flex: 1 },
  InviteRole:     { color: '#666', marginTop: 2 },
  InviteActions:  { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
