import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Divider, IconButton, List, Switch, Text } from 'react-native-paper';
import Constants from 'expo-constants';
import { useSettings } from '../contexts/SettingsContext';

const BANDING_WARNING =
  'Bird banding is a federally regulated process according to the Migratory Bird Treaty Act, 50 CFR 21.70. ' +
  'This requires a federal bird banding permit, as well as permits from states and provinces to legally band a bird. ' +
  'It is a violation of federal law to band birds without a permit. ' +
  'Do not use your own bands that are sold for pigeons or other non-native birds. ' +
  'These can harm or kill birds for which they are not properly sized.\n\n' +
  'Permits are NOT required to observe and report on observations of birds you encounter, ' +
  'and we encourage you to report them at reportband.gov';

export default function SettingsScreen() {
  const { BandingEnabled, toggleBandingEnabled, FledgingWarnDays, setFledgingWarnDays } = useSettings();

  return (
    <ScrollView contentContainerStyle={styles.Container}>
      <Text variant="labelLarge" style={styles.SectionHeader}>Features</Text>
      <Divider />
      <List.Item
        title="Banding support"
        description="Show banding windows, band records, and banding fields on nest check forms"
        right={() => (
          <View style={styles.SwitchWrap}>
            <Switch value={BandingEnabled} onValueChange={toggleBandingEnabled} />
          </View>
        )}
      />
      {BandingEnabled && (
        <View style={styles.BandingWarning}>
          <Text variant="labelSmall" style={styles.BandingWarningTitle}>⚠ Legal Notice</Text>
          <Text variant="bodySmall" style={styles.BandingWarningText}>{BANDING_WARNING}</Text>
        </View>
      )}
      <Divider />
      <List.Item
        title="Pre-fledge warning"
        description={
          FledgingWarnDays === 0
            ? 'Disabled'
            : `Warn when young are within ${FledgingWarnDays} day${FledgingWarnDays === 1 ? '' : 's'} of fledging`
        }
        right={() => (
          <View style={styles.Stepper}>
            <IconButton
              icon="minus"
              size={20}
              disabled={FledgingWarnDays === 0}
              onPress={() => setFledgingWarnDays(FledgingWarnDays - 1)}
            />
            <Text style={styles.StepperValue}>{FledgingWarnDays}</Text>
            <IconButton
              icon="plus"
              size={20}
              disabled={FledgingWarnDays >= 7}
              onPress={() => setFledgingWarnDays(FledgingWarnDays + 1)}
            />
          </View>
        )}
      />
      <Divider />
      <Text variant="bodySmall" style={styles.BuildInfo}>
        Version {Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? '—'} · Build {Constants.nativeBuildVersion ?? 'dev'}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  Container:           { padding: 16 },
  SectionHeader:       { marginBottom: 8, color: '#555' },
  SwitchWrap:          { justifyContent: 'center' },
  BandingWarning:      { backgroundColor: '#fff8e1', borderRadius: 8, padding: 12, marginTop: 8, marginBottom: 4 },
  BandingWarningTitle: { fontWeight: '700', color: '#b45309', marginBottom: 4 },
  BandingWarningText:  { color: '#78350f', lineHeight: 18 },
  Stepper:             { flexDirection: 'row', alignItems: 'center' },
  StepperValue:        { width: 24, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  BuildInfo:           { marginTop: 16, color: '#aaa', textAlign: 'center' },
});
