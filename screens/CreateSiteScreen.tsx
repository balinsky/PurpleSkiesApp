import React, { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Button, Card, HelperText, Text, TextInput } from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { AppStackParamList } from '../App';

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'CreateSite'>;
};

export default function CreateSiteScreen({ navigation }: Props) {
  const [SiteName, setSiteName] = useState('');
  const [SiteLocation, setSiteLocation] = useState('');
  const [Loading, setLoading] = useState(false);
  const [ErrorMessage, setErrorMessage] = useState('');

  async function handleCreate() {
    setErrorMessage('');
    if (!SiteName.trim()) {
      setErrorMessage('Please enter a name for this site.');
      return;
    }
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('sites').insert({
      name: SiteName.trim(),
      address: SiteLocation.trim() || null,
      owner_id: user!.id,
    });
    setLoading(false);
    if (error) {
      setErrorMessage(error.message);
    } else {
      navigation.goBack();
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.Container}>
      <TextInput
        label="Site name *"
        value={SiteName}
        onChangeText={setSiteName}
        placeholder="e.g. Patterson Park, XYZ Elementary School"
        style={styles.Input}
      />
      <TextInput
        label="Site location"
        value={SiteLocation}
        onChangeText={setSiteLocation}
        placeholder="Address or description of where the housing is"
        style={styles.Input}
      />
      <HelperText type="info" visible>
        The location can be an address or a verbal description, e.g. "Behind the school gymnasium on the east field."
      </HelperText>

      {ErrorMessage ? <HelperText type="error" visible>{ErrorMessage}</HelperText> : null}

      <Button mode="contained" onPress={handleCreate} loading={Loading} style={styles.Button}>
        Create Site
      </Button>

      <Card style={styles.PmcaCard} mode="contained">
        <Card.Content>
          <Text variant="titleSmall" style={styles.PmcaTitle}>
            Help Purple Martin research
          </Text>
          <Text variant="bodySmall">
            The Purple Martin Conservation Association (PMCA) tracks population trends across North America.
            Filling in complete site details makes it easy to submit your season's data to{' '}
            <Text style={styles.Email}>research@purplemartin.org</Text>{' '}
            at the end of the season — and every nest check you record contributes to continental science.
          </Text>
        </Card.Content>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  Container: { padding: 16 },
  Input:     { marginBottom: 8 },
  Button:    { marginTop: 8, marginBottom: 24 },
  PmcaCard:  { backgroundColor: '#f0f7ff' },
  PmcaTitle: { marginBottom: 6 },
  Email:     { fontWeight: 'bold' },
});
