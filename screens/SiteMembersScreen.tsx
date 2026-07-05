import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  Button, Card, Chip, Dialog, HelperText,
  List, Portal, RadioButton, Text, TextInput,
} from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { friendlyError } from '../lib/errorUtils';
import { AppStackParamList } from '../App';

type Member = {
  memberId: string;   // 'owner' for site owner, site_members.id for others
  userId:   string;
  role:     string;
  email:    string;
  displayName: string | null;
  isOwner:  boolean;
};

type Invitation = {
  id:           string;
  invited_email: string;
  role:         string;
};

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'SiteMembers'>;
  route:      RouteProp<AppStackParamList, 'SiteMembers'>;
};

const RoleLabel: Record<string, string> = {
  owner:     'Owner',
  manager:   'Manager',
  collector: 'Collector',
  viewer:    'Viewer',
};

export default function SiteMembersScreen({ navigation, route }: Props) {
  const { SiteId } = route.params;

  const [CurrentUserId, setCurrentUserId] = useState<string | null>(null);
  const [IsOwner, setIsOwner]             = useState(false);
  const [MyRole, setMyRole]               = useState<string | null>(null);
  const [Members, setMembers]             = useState<Member[]>([]);
  const [Invitations, setInvitations]     = useState<Invitation[]>([]);
  const [Loading, setLoading]             = useState(true);
  const [PageError, setPageError]         = useState('');

  // ── Invite dialog ─────────────────────────────────────────────────────
  const [InviteVisible, setInviteVisible]   = useState(false);
  const [InviteEmail, setInviteEmail]       = useState('');
  const [InviteRole, setInviteRole]         = useState<'manager' | 'collector' | 'viewer'>('collector');
  const [InviteLoading, setInviteLoading]   = useState(false);
  const [InviteError, setInviteError]       = useState('');

  // ── Change role dialog ────────────────────────────────────────────────
  const [RoleDialogVisible, setRoleDialogVisible]   = useState(false);
  const [RoleDialogMember, setRoleDialogMember]     = useState<Member | null>(null);
  const [RoleDialogValue, setRoleDialogValue]       = useState<'manager' | 'collector' | 'viewer'>('collector');
  const [RoleDialogLoading, setRoleDialogLoading]   = useState(false);
  const [RoleDialogError, setRoleDialogError]       = useState('');

  const CanManage = IsOwner || MyRole === 'manager';

  useFocusEffect(
    useCallback(() => { loadAll(); }, [SiteId])
  );

  async function loadAll() {
    setLoading(true);
    setPageError('');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setCurrentUserId(user.id);

    const [{ data: SiteRow }, { data: MemberRows }, { data: InvRows }] = await Promise.all([
      supabase.from('sites').select('owner_id').eq('id', SiteId).single(),
      supabase.from('site_members')
        .select('id, user_id, role')
        .eq('site_id', SiteId)
        .order('joined_at'),
      supabase.from('invitations')
        .select('id, invited_email, role')
        .eq('site_id', SiteId)
        .is('accepted_at', null)
        .order('created_at'),
    ]);

    const owner = SiteRow?.owner_id === user.id;
    setIsOwner(owner);

    // Fetch profiles for all user_ids in one query
    const UserIds = [
      ...(SiteRow?.owner_id ? [SiteRow.owner_id] : []),
      ...(MemberRows ?? []).map(m => m.user_id),
    ];
    const ProfileMap = new Map<string, { email: string; display_name: string | null }>();
    if (UserIds.length > 0) {
      const { data: ProfileRows } = await supabase
        .from('profiles').select('id, email, display_name').in('id', UserIds);
      for (const P of ProfileRows ?? []) ProfileMap.set(P.id, P);
    }

    const List: Member[] = [];

    // Owner entry
    if (SiteRow?.owner_id) {
      const P = ProfileMap.get(SiteRow.owner_id);
      List.push({
        memberId:    'owner',
        userId:      SiteRow.owner_id,
        role:        'owner',
        email:       P?.email ?? '',
        displayName: P?.display_name ?? null,
        isOwner:     true,
      });
    }

    for (const M of MemberRows ?? []) {
      const P = ProfileMap.get(M.user_id);
      if (M.user_id === user.id) setMyRole(M.role);
      List.push({
        memberId:    M.id,
        userId:      M.user_id,
        role:        M.role,
        email:       P?.email ?? '',
        displayName: P?.display_name ?? null,
        isOwner:     false,
      });
    }

    if (owner) setMyRole('owner');

    setMembers(List);
    setInvitations(InvRows ?? []);
    setLoading(false);
  }

  // ── Invite ────────────────────────────────────────────────────────────
  async function handleInvite() {
    const Email = InviteEmail.trim().toLowerCase();
    if (!Email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(Email)) {
      setInviteError('Please enter a valid email address.');
      return;
    }
    setInviteLoading(true);
    setInviteError('');
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('invitations').insert({
      site_id:       SiteId,
      site_name:     route.params.SiteName,
      invited_email: Email,
      role:          InviteRole,
      invited_by:    user!.id,
    });
    setInviteLoading(false);
    if (error) {
      setInviteError(error.code === '23505' ? 'This person is already invited.' : friendlyError(error, 'Failed to send invitation.'));
      return;
    }
    setInviteVisible(false);
    loadAll();
  }

  // ── Remove member ─────────────────────────────────────────────────────
  async function handleRemove(M: Member) {
    await supabase.from('site_members').delete().eq('id', M.memberId);
    loadAll();
  }

  // ── Leave site ────────────────────────────────────────────────────────
  async function handleLeave() {
    if (!CurrentUserId) return;
    await supabase.from('site_members')
      .delete().eq('site_id', SiteId).eq('user_id', CurrentUserId);
    navigation.goBack();
    navigation.goBack(); // back past SiteDetail to Home
  }

  // ── Cancel invitation ─────────────────────────────────────────────────
  async function handleCancelInvitation(Id: string) {
    await supabase.from('invitations').delete().eq('id', Id);
    loadAll();
  }

  // ── Change role ───────────────────────────────────────────────────────
  function openChangeRole(M: Member) {
    setRoleDialogMember(M);
    setRoleDialogValue(M.role as any);
    setRoleDialogError('');
    setRoleDialogVisible(true);
  }

  async function handleChangeRole() {
    if (!RoleDialogMember) return;
    setRoleDialogLoading(true);
    const { error } = await supabase.from('site_members')
      .update({ role: RoleDialogValue }).eq('id', RoleDialogMember.memberId);
    setRoleDialogLoading(false);
    if (error) { setRoleDialogError(friendlyError(error)); return; }
    setRoleDialogVisible(false);
    loadAll();
  }

  if (Loading) {
    return <View style={styles.Center}><Text>Loading…</Text></View>;
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.Container}>
        {PageError ? <HelperText type="error" visible>{PageError}</HelperText> : null}

        <Text variant="labelLarge" style={styles.SectionLabel}>Members</Text>

        {Members.map((M) => {
          const Title    = M.displayName ?? (CanManage ? M.email : 'Member');
          const Subtitle = CanManage && M.displayName ? M.email : undefined;
          const IsMe     = M.userId === CurrentUserId;
          const Editable = CanManage && !M.isOwner && !IsMe;
          return (
            <Card key={M.memberId} style={styles.Card} mode="outlined">
              <Card.Title
                title={Title}
                subtitle={Subtitle}
                right={() => (
                  <View style={styles.CardRight}>
                    <Chip compact style={styles.RoleChip}>{RoleLabel[M.role] ?? M.role}</Chip>
                    {Editable && (
                      <Button mode="text" compact onPress={() => openChangeRole(M)}>Edit</Button>
                    )}
                  </View>
                )}
              />
              {Editable && (
                <Card.Actions style={styles.CardActions}>
                  <Button textColor="red" compact onPress={() => handleRemove(M)}>Remove</Button>
                </Card.Actions>
              )}
            </Card>
          );
        })}

        {CanManage && (
          <Button
            mode="outlined" icon="account-plus"
            style={styles.InviteBtn}
            onPress={() => {
              setInviteEmail('');
              setInviteRole('collector');
              setInviteError('');
              setInviteVisible(true);
            }}
          >
            Invite someone
          </Button>
        )}

        {Invitations.length > 0 && (
          <>
            <Text variant="labelLarge" style={[styles.SectionLabel, styles.SectionLabelSpaced]}>
              Pending Invitations
            </Text>
            {Invitations.map((Inv) => (
              <Card key={Inv.id} style={styles.Card} mode="outlined">
                <Card.Title
                  title={CanManage ? Inv.invited_email : 'Pending invitation'}
                  subtitle={`Invited as ${RoleLabel[Inv.role] ?? Inv.role}`}
                  right={CanManage ? () => (
                    <Button
                      mode="text" compact textColor="red"
                      onPress={() => handleCancelInvitation(Inv.id)}
                      style={styles.CancelBtn}
                    >
                      Cancel
                    </Button>
                  ) : undefined}
                />
              </Card>
            ))}
          </>
        )}

        {!IsOwner && MyRole && (
          <Button
            mode="outlined" textColor="red"
            style={styles.LeaveBtn}
            onPress={handleLeave}
          >
            Leave this site
          </Button>
        )}
      </ScrollView>

      <Portal>
        {/* ── Invite dialog ─────────────────────────────────────────── */}
        <Dialog visible={InviteVisible} onDismiss={() => setInviteVisible(false)}>
          <Dialog.Title>Invite someone</Dialog.Title>
          <Dialog.ScrollArea style={styles.DialogScroll}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <TextInput
                label="Email address"
                value={InviteEmail}
                onChangeText={setInviteEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                maxLength={200}
                style={styles.DialogInput}
              />
              <Text style={styles.RolePickerLabel}>Role</Text>
              <RadioButton.Group value={InviteRole} onValueChange={v => setInviteRole(v as any)}>
                <RadioButton.Item label="Manager — can invite members and enter data" value="manager"   style={styles.Radio} />
                <RadioButton.Item label="Collector — can enter nest check data"       value="collector" style={styles.Radio} />
                <RadioButton.Item label="Viewer — read only"                          value="viewer"    style={styles.Radio} />
              </RadioButton.Group>
              {InviteError ? <HelperText type="error" visible>{InviteError}</HelperText> : null}
              <HelperText type="info" visible>
                They will be added when they next sign in with this email address.
              </HelperText>
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setInviteVisible(false)}>Cancel</Button>
            <Button loading={InviteLoading} onPress={handleInvite}>Invite</Button>
          </Dialog.Actions>
        </Dialog>

        {/* ── Change role dialog ────────────────────────────────────── */}
        <Dialog visible={RoleDialogVisible} onDismiss={() => setRoleDialogVisible(false)}>
          <Dialog.Title>
            Change role{RoleDialogMember ? ` for ${RoleDialogMember.displayName ?? RoleDialogMember.email}` : ''}
          </Dialog.Title>
          <Dialog.Content>
            <RadioButton.Group value={RoleDialogValue} onValueChange={v => setRoleDialogValue(v as any)}>
              <RadioButton.Item label="Manager"   value="manager"   style={styles.Radio} />
              <RadioButton.Item label="Collector" value="collector" style={styles.Radio} />
              <RadioButton.Item label="Viewer"    value="viewer"    style={styles.Radio} />
            </RadioButton.Group>
            {RoleDialogError ? <HelperText type="error" visible>{RoleDialogError}</HelperText> : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setRoleDialogVisible(false)}>Cancel</Button>
            <Button loading={RoleDialogLoading} onPress={handleChangeRole}>Save</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  Center:            { flex: 1, justifyContent: 'center', alignItems: 'center' },
  Container:         { padding: 16, paddingBottom: 40 },
  SectionLabel:      { marginBottom: 8 },
  SectionLabelSpaced:{ marginTop: 20 },
  Card:              { marginBottom: 8 },
  CardRight:         { flexDirection: 'row', alignItems: 'center', paddingRight: 8, gap: 4 },
  RoleChip:          {},
  CardActions:       { justifyContent: 'flex-end', paddingTop: 0 },
  InviteBtn:         { alignSelf: 'flex-start', marginTop: 8 },
  LeaveBtn:          { alignSelf: 'flex-start', marginTop: 24, borderColor: 'red' },
  CancelBtn:         { marginRight: 8 },
  DialogScroll:      { maxHeight: 400 },
  DialogInput:       { marginBottom: 4 },
  RolePickerLabel:   { fontWeight: '600', fontSize: 13, marginTop: 12, marginBottom: 2, paddingHorizontal: 4 },
  Radio:             { paddingVertical: 2 },
});
