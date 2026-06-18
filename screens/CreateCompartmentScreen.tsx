import React, { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Button, HelperText, RadioButton, Text, TextInput } from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { friendlyError } from '../lib/errorUtils';
import { AppStackParamList } from '../App';

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'CreateCompartment'>;
  route: RouteProp<AppStackParamList, 'CreateCompartment'>;
};

const HoleTypes = [
  { label: 'Crescent (CR)',  value: 'CR' },
  { label: 'Excluder (EX)', value: 'EX' },
  { label: 'Obround (OB)',  value: 'OB' },
  { label: 'Round (R)',     value: 'R' },
];

const GourdTypes = [
  { label: 'Artificial Gourd (AG)', value: 'AG' },
  { label: 'Natural Gourd (NG)',    value: 'NG' },
];

function autoHousingType(UnitType: string): string {
  switch (UnitType) {
    case 'metal_house':   return 'MH';
    case 'plastic_house': return 'PH';
    case 'wooden_house':  return 'WH';
    default:              return 'NG';
  }
}

export default function CreateCompartmentScreen({ navigation, route }: Props) {
  const { UnitId, UnitType, DefaultHoleType } = route.params;
  const IsGourdRack = UnitType === 'gourd_rack';

  const [CavityLabel, setCavityLabel] = useState('');
  const [HoleType, setHoleType] = useState(DefaultHoleType ?? 'CR');
  const [GourdType, setGourdType] = useState('AG');
  const [OverrideHoleType, setOverrideHoleType] = useState(false);
  const [Loading, setLoading] = useState(false);
  const [ErrorMessage, setErrorMessage] = useState('');

  async function handleCreate() {
    setErrorMessage('');
    if (!CavityLabel.trim()) {
      setErrorMessage('Please enter a label for this compartment.');
      return;
    }
    setLoading(true);

    const { count } = await supabase
      .from('compartments')
      .select('*', { count: 'exact', head: true })
      .eq('housing_unit_id', UnitId);

    const HousingType = IsGourdRack ? GourdType : autoHousingType(UnitType);

    const { error } = await supabase.from('compartments').insert({
      housing_unit_id: UnitId,
      cavity_label: CavityLabel.trim(),
      housing_type: HousingType,
      hole_type: HoleType,
      sort_order: (count ?? 0) + 1,
    });

    setLoading(false);
    if (error) {
      setErrorMessage(friendlyError(error, 'Failed to create compartment.'));
    } else {
      setCavityLabel('');
      navigation.goBack();
    }
  }

  async function handleCreateAndAnother() {
    setErrorMessage('');
    if (!CavityLabel.trim()) {
      setErrorMessage('Please enter a label for this compartment.');
      return;
    }
    setLoading(true);

    const { count } = await supabase
      .from('compartments')
      .select('*', { count: 'exact', head: true })
      .eq('housing_unit_id', UnitId);

    const HousingType = IsGourdRack ? GourdType : autoHousingType(UnitType);

    const { error } = await supabase.from('compartments').insert({
      housing_unit_id: UnitId,
      cavity_label: CavityLabel.trim(),
      housing_type: HousingType,
      hole_type: HoleType,
      sort_order: (count ?? 0) + 1,
    });

    setLoading(false);
    if (error) {
      setErrorMessage(friendlyError(error, 'Failed to create compartment.'));
    } else {
      setCavityLabel('');
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.Container}>
      <TextInput
        label="Compartment label *"
        value={CavityLabel}
        onChangeText={setCavityLabel}
        placeholder="e.g. A1, 3, North Gourd"
        maxLength={20}
        style={styles.Input}
        autoFocus
      />

      {IsGourdRack && (
        <>
          <Text variant="labelLarge" style={styles.Label}>Gourd type</Text>
          <RadioButton.Group onValueChange={setGourdType} value={GourdType}>
            {GourdTypes.map((G) => (
              <RadioButton.Item key={G.value} label={G.label} value={G.value} />
            ))}
          </RadioButton.Group>
        </>
      )}

      <Button
        mode="text"
        compact
        style={styles.OverrideToggle}
        onPress={() => setOverrideHoleType(!OverrideHoleType)}
      >
        {OverrideHoleType ? 'Use default hole type' : `Override hole type (default: ${DefaultHoleType ?? 'none'})`}
      </Button>

      {OverrideHoleType && (
        <>
          <Text variant="labelLarge" style={styles.Label}>Hole type</Text>
          <RadioButton.Group onValueChange={setHoleType} value={HoleType}>
            {HoleTypes.map((H) => (
              <RadioButton.Item key={H.value} label={H.label} value={H.value} />
            ))}
          </RadioButton.Group>
        </>
      )}

      {ErrorMessage ? <HelperText type="error" visible>{ErrorMessage}</HelperText> : null}

      <Button mode="contained" onPress={handleCreate} loading={Loading} style={styles.Button}>
        Save &amp; Done
      </Button>
      <Button mode="outlined" onPress={handleCreateAndAnother} loading={Loading} style={styles.Button}>
        Save &amp; Add Another
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  Container:     { padding: 16 },
  Input:         { marginBottom: 8 },
  Label:         { marginTop: 16, marginBottom: 4 },
  OverrideToggle:{ alignSelf: 'flex-start', marginTop: 12 },
  Button:        { marginTop: 12 },
});
