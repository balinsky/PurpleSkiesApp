import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, HelperText, RadioButton, Text, TextInput } from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { friendlyError } from '../lib/errorUtils';
import { AppStackParamList } from '../App';

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'CreateHousingUnit'>;
  route: RouteProp<AppStackParamList, 'CreateHousingUnit'>;
};

const UnitTypes = [
  { label: 'Metal House',   value: 'metal_house' },
  { label: 'Plastic House', value: 'plastic_house' },
  { label: 'Wooden House',  value: 'wooden_house' },
  { label: 'Gourd Rack',    value: 'gourd_rack' },
];

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

const LabelStyles = [
  { label: 'Numeric (1, 2, 3…)',         value: 'numeric' },
  { label: 'Alphabetic (A, B, C…)',      value: 'alpha' },
  { label: 'Prefix + number (A1, A2…)', value: 'prefix' },
  { label: 'Other (enter labels)',        value: 'other' },
];

function housingTypeForUnit(UnitType: string, GourdType: string): string {
  switch (UnitType) {
    case 'metal_house':   return 'MH';
    case 'plastic_house': return 'PH';
    case 'wooden_house':  return 'WH';
    default:              return GourdType;
  }
}

function generateLabels(Style: string, Count: number, Prefix: string): string[] {
  return Array.from({ length: Count }, (_, I) => {
    if (Style === 'numeric')  return String(I + 1);
    if (Style === 'alpha')    return String.fromCharCode(65 + I);
    return `${Prefix}${I + 1}`;
  });
}

export default function CreateHousingUnitScreen({ navigation, route }: Props) {
  const { SiteId, SeasonId } = route.params;
  const [UnitName, setUnitName]     = useState('');
  const [UnitType, setUnitType]     = useState('metal_house');
  const [HoleType, setHoleType]     = useState('CR');
  const [GourdType, setGourdType]   = useState('AG');
  const [Count, setCount]           = useState('12');
  const [CustomLabels, setCustomLabels] = useState('');
  const [LabelStyle, setLabelStyle] = useState('numeric');
  const [Prefix, setPrefix]         = useState('');
  const [Loading, setLoading]       = useState(false);
  const [ErrorMessage, setErrorMessage] = useState('');

  async function handleCreate() {
    setErrorMessage('');
    if (!UnitName.trim()) { setErrorMessage('Please enter a name.'); return; }
    if (LabelStyle === 'prefix' && !Prefix.trim()) { setErrorMessage('Please enter a label prefix.'); return; }

    let Labels: string[];
    if (LabelStyle === 'other') {
      Labels = CustomLabels.split(',').map((L) => L.trim()).filter((L) => L.length > 0);
      if (Labels.length === 0) { setErrorMessage('Please enter at least one compartment label.'); return; }
    } else {
      const NumCount = parseInt(Count, 10);
      if (isNaN(NumCount) || NumCount < 1) { setErrorMessage('Please enter a valid number of compartments.'); return; }
      Labels = generateLabels(LabelStyle, NumCount, Prefix.trim());
    }

    setLoading(true);

    const { data: Unit, error: UnitError } = await supabase
      .from('housing_units')
      .insert({ site_id: SiteId, site_season_id: SeasonId, name: UnitName.trim(), unit_type: UnitType, default_hole_type: HoleType })
      .select()
      .single();

    if (UnitError) { setErrorMessage(friendlyError(UnitError, 'Failed to create housing unit.')); setLoading(false); return; }

    const HousingType = housingTypeForUnit(UnitType, GourdType);
    const Compartments = Labels.map((Label, I) => ({
      housing_unit_id: Unit.id,
      site_season_id: SeasonId,
      cavity_label: Label,
      housing_type: HousingType,
      hole_type: HoleType,
      sort_order: I + 1,
    }));

    const { error: CompError } = await supabase.from('compartments').insert(Compartments);
    setLoading(false);

    if (CompError) { setErrorMessage(friendlyError(CompError, 'Failed to create compartments.')); return; }

    navigation.replace('HousingUnitDetail', {
      UnitId: Unit.id,
      UnitName: Unit.name,
      UnitType: Unit.unit_type,
      DefaultHoleType: Unit.default_hole_type,
      SeasonId,
    });
  }

  return (
    <ScrollView contentContainerStyle={styles.Container} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">

      <TextInput
        label="Unit name *"
        value={UnitName}
        onChangeText={setUnitName}
        placeholder="e.g. Main House, East Rack"
        maxLength={100}
        style={styles.Input}
      />

      <Text variant="labelLarge" style={styles.Label}>Housing type</Text>
      <RadioButton.Group onValueChange={setUnitType} value={UnitType}>
        {UnitTypes.map((T) => <RadioButton.Item key={T.value} label={T.label} value={T.value} />)}
      </RadioButton.Group>

      {UnitType === 'gourd_rack' && (
        <>
          <Text variant="labelLarge" style={styles.Label}>Gourd type</Text>
          <RadioButton.Group onValueChange={setGourdType} value={GourdType}>
            {GourdTypes.map((G) => <RadioButton.Item key={G.value} label={G.label} value={G.value} />)}
          </RadioButton.Group>
        </>
      )}

      <Text variant="labelLarge" style={styles.Label}>Default hole type</Text>
      <Text variant="bodySmall" style={styles.Hint}>Individual compartments can override this.</Text>
      <RadioButton.Group onValueChange={setHoleType} value={HoleType}>
        {HoleTypes.map((H) => <RadioButton.Item key={H.value} label={H.label} value={H.value} />)}
      </RadioButton.Group>

      <Text variant="labelLarge" style={styles.Label}>Compartment labels</Text>
      <RadioButton.Group onValueChange={setLabelStyle} value={LabelStyle}>
        {LabelStyles.map((L) => <RadioButton.Item key={L.value} label={L.label} value={L.value} />)}
      </RadioButton.Group>

      {LabelStyle === 'other' ? (
        <>
          <TextInput
            label="Labels (comma separated)"
            value={CustomLabels}
            onChangeText={setCustomLabels}
            placeholder="e.g. A1, A2, B1, B2, North, South"
            multiline
            maxLength={500}
            style={styles.Input}
          />
          {CustomLabels.trim().length > 0 && (
            <HelperText type="info" visible>
              {CustomLabels.split(',').filter((L) => L.trim().length > 0).length} compartments detected
            </HelperText>
          )}
        </>
      ) : (
        <>
          <Text variant="labelLarge" style={styles.Label}>Number of compartments</Text>
          <TextInput
            value={Count}
            onChangeText={setCount}
            keyboardType="numeric"
            style={styles.ShortInput}
          />
          {LabelStyle === 'prefix' && (
            <>
              <TextInput
                label="Label prefix"
                value={Prefix}
                onChangeText={setPrefix}
                placeholder="e.g. A"
                maxLength={10}
                style={styles.Input}
              />
              {Prefix.trim().length > 0 && (
                <HelperText type="info" visible>
                  Will generate: {Prefix.trim()}1, {Prefix.trim()}2, {Prefix.trim()}3…
                </HelperText>
              )}
            </>
          )}
          {LabelStyle === 'alpha' && parseInt(Count, 10) > 26 && (
            <HelperText type="error" visible>
              Alphabetic labels only support up to 26 compartments (A–Z).
            </HelperText>
          )}
        </>
      )}

      {ErrorMessage ? <HelperText type="error" visible>{ErrorMessage}</HelperText> : null}

      <Button mode="contained" onPress={handleCreate} loading={Loading} style={styles.Button}>
        Create Housing Unit
      </Button>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  Container:     { padding: 16 },
  Input:         { marginBottom: 8 },
  ShortInput:    { marginBottom: 8, width: 100 },
  Label:         { marginTop: 16, marginBottom: 4 },
  Hint:          { color: '#666', marginBottom: 4 },
  Button:        { marginTop: 24 },
  PrefixRow:     { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  PrefixInput:   { flex: 0, width: 100 },
  PrefixPreview: { color: '#555', flexShrink: 1 },
});
