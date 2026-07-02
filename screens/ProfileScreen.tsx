import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Button, Divider, HelperText, Text, TextInput } from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { friendlyAuthError } from '../lib/errorUtils';
import { AppStackParamList } from '../App';

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'Profile'>;
};

export default function ProfileScreen({ navigation }: Props) {
  const [Email, setEmail]           = useState('');
  const [Name, setName]             = useState('');
  const [Phone, setPhone]           = useState('');
  const [Fetching, setFetching]     = useState(true);
  const [Saving, setSaving]         = useState(false);
  const [SaveError, setSaveError]   = useState('');
  const [SaveSuccess, setSaveSuccess] = useState(false);
  const [SigningOut, setSigningOut]  = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setEmail(user.email ?? '');
        setName(user.user_metadata?.name ?? '');
        setPhone(user.user_metadata?.phone ?? '');
      }
      setFetching(false);
    });
  }, []);

  async function handleSave() {
    setSaveError('');
    setSaveSuccess(false);
    setSaving(true);
    const { data: { user }, error: AuthErr } = await supabase.auth.updateUser({
      data: { name: Name.trim() || null, phone: Phone.trim() || null },
    });
    if (AuthErr) { setSaving(false); setSaveError(friendlyAuthError(AuthErr)); return; }
    if (user) {
      await supabase.from('profiles').upsert({
        id:           user.id,
        email:        user.email ?? '',
        display_name: Name.trim() || null,
      });
    }
    setSaving(false);
    setSaveSuccess(true);
  }

  async function handleSignOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
  }

  if (Fetching) return null;

  return (
    <ScrollView contentContainerStyle={styles.Container} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
      <TextInput
        label="Email"
        value={Email}
        editable={false}
        style={styles.Input}
      />
      <HelperText type="info" visible style={styles.EmailHint}>
        Email cannot be changed. Name and phone are optional.
      </HelperText>
      <TextInput
        label="Name"
        value={Name}
        onChangeText={v => { setName(v); setSaveSuccess(false); }}
        autoCapitalize="words"
        maxLength={100}
        style={styles.Input}
      />
      <TextInput
        label="Phone"
        value={Phone}
        onChangeText={v => { setPhone(v); setSaveSuccess(false); }}
        keyboardType="phone-pad"
        maxLength={20}
        style={styles.Input}
      />
      {SaveError  ? <HelperText type="error"   visible>{SaveError}</HelperText>  : null}
      {SaveSuccess ? <HelperText type="info" visible>Saved.</HelperText> : null}
      <Button mode="contained" loading={Saving} onPress={handleSave} style={styles.SaveBtn}>
        Save
      </Button>

      <Divider style={styles.Divider} />

      <Button
        mode="outlined"
        textColor="red"
        loading={SigningOut}
        onPress={handleSignOut}
        style={styles.SignOutBtn}
      >
        Sign out
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  Container:  { padding: 16 },
  Input:      { marginBottom: 4 },
  EmailHint:  { marginBottom: 8 },
  SaveBtn:    { marginTop: 8 },
  Divider:    { marginVertical: 24 },
  SignOutBtn: { borderColor: 'red', alignSelf: 'flex-start' },
});
