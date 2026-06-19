import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Divider, List, Switch, Text } from 'react-native-paper';
import { useSettings } from '../contexts/SettingsContext';

export default function SettingsScreen() {
  const { BandingEnabled, toggleBandingEnabled } = useSettings();

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
      <Divider />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  Container:     { padding: 16 },
  SectionHeader: { marginBottom: 8, color: '#555' },
  SwitchWrap:    { justifyContent: 'center' },
});
