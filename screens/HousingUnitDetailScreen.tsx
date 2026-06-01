import React, { useCallback, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';
import {
  Button, Card, Dialog, FAB, HelperText, IconButton,
  Portal, RadioButton, Text, TextInput,
} from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { AppStackParamList } from '../App';

type Compartment = {
  id: string;
  cavity_label: string;
  housing_type: string;
  hole_type: string;
  sort_order: number | null;
};

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'HousingUnitDetail'>;
  route: RouteProp<AppStackParamList, 'HousingUnitDetail'>;
};

const UnitTypeLabel: Record<string, string> = {
  metal_house:   'Metal House',
  plastic_house: 'Plastic House',
  wooden_house:  'Wooden House',
  gourd_rack:    'Gourd Rack',
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

export default function HousingUnitDetailScreen({ navigation, route }: Props) {
  const { UnitId, UnitName, UnitType, DefaultHoleType } = route.params;
  const IsGourdRack = UnitType === 'gourd_rack';

  const [Compartments, setCompartments] = useState<Compartment[]>([]);
  const [Loading, setLoading]           = useState(true);

  // ── Edit unit ────────────────────────────────────────────────────────
  const [EditUnitVisible, setEditUnitVisible]       = useState(false);
  const [EditUnitName, setEditUnitName]             = useState('');
  const [EditDefaultHole, setEditDefaultHole]       = useState('CR');
  const [EditUnitLoading, setEditUnitLoading]       = useState(false);
  const [EditUnitError, setEditUnitError]           = useState('');

  // ── Delete unit ──────────────────────────────────────────────────────
  const [DeleteUnitVisible, setDeleteUnitVisible]   = useState(false);
  const [DeleteUnitLoading, setDeleteUnitLoading]   = useState(false);
  const [DeleteUnitError, setDeleteUnitError]       = useState('');

  // ── Edit compartment ─────────────────────────────────────────────────
  const [EditCompVisible, setEditCompVisible]       = useState(false);
  const [EditingComp, setEditingComp]               = useState<Compartment | null>(null);
  const [EditCompLabel, setEditCompLabel]           = useState('');
  const [EditCompHoleType, setEditCompHoleType]     = useState('CR');
  const [EditCompHousing, setEditCompHousing]       = useState('AG');
  const [EditCompOverride, setEditCompOverride]     = useState(false);
  const [EditCompLoading, setEditCompLoading]       = useState(false);
  const [EditCompError, setEditCompError]           = useState('');

  // ── Delete compartment ───────────────────────────────────────────────
  const [DeleteCompVisible, setDeleteCompVisible]   = useState(false);
  const [DeletingComp, setDeletingComp]             = useState<Compartment | null>(null);
  const [DeleteCompLoading, setDeleteCompLoading]   = useState(false);
  const [DeleteCompError, setDeleteCompError]       = useState('');

  useFocusEffect(useCallback(() => { loadCompartments(); }, [UnitId]));

  function loadCompartments() {
    supabase
      .from('compartments')
      .select('id, cavity_label, housing_type, hole_type, sort_order')
      .eq('housing_unit_id', UnitId)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('cavity_label', { ascending: true })
      .then(({ data }) => { setCompartments(data ?? []); setLoading(false); });
  }

  // ── Edit unit handlers ───────────────────────────────────────────────
  function openEditUnit() {
    setEditUnitName(UnitName);
    setEditDefaultHole(DefaultHoleType ?? 'CR');
    setEditUnitError('');
    setEditUnitVisible(true);
  }

  async function handleSaveUnit() {
    if (!EditUnitName.trim()) { setEditUnitError('Please enter a name.'); return; }
    setEditUnitLoading(true);
    const { error } = await supabase
      .from('housing_units')
      .update({ name: EditUnitName.trim(), default_hole_type: EditDefaultHole })
      .eq('id', UnitId);
    setEditUnitLoading(false);
    if (error) { setEditUnitError(error.message); return; }
    setEditUnitVisible(false);
    navigation.setParams({ UnitName: EditUnitName.trim(), DefaultHoleType: EditDefaultHole });
  }

  // ── Delete unit handlers ─────────────────────────────────────────────
  async function handleDeleteUnit() {
    setDeleteUnitLoading(true);
    setDeleteUnitError('');
    const { error } = await supabase.from('housing_units').delete().eq('id', UnitId);
    setDeleteUnitLoading(false);
    if (error) { setDeleteUnitError(error.message); return; }
    setDeleteUnitVisible(false);
    navigation.goBack();
  }

  // ── Edit compartment handlers ────────────────────────────────────────
  function openEditComp(Comp: Compartment) {
    setEditingComp(Comp);
    setEditCompLabel(Comp.cavity_label);
    setEditCompHoleType(Comp.hole_type);
    setEditCompHousing(Comp.housing_type);
    setEditCompOverride(Comp.hole_type !== (DefaultHoleType ?? 'CR'));
    setEditCompError('');
    setEditCompVisible(true);
  }

  async function handleSaveComp() {
    if (!EditCompLabel.trim()) { setEditCompError('Please enter a label.'); return; }
    if (!EditingComp) return;
    setEditCompLoading(true);
    const { error } = await supabase
      .from('compartments')
      .update({
        cavity_label:  EditCompLabel.trim(),
        hole_type:     EditCompOverride ? EditCompHoleType : (DefaultHoleType ?? 'CR'),
        ...(IsGourdRack && { housing_type: EditCompHousing }),
      })
      .eq('id', EditingComp.id);
    setEditCompLoading(false);
    if (error) { setEditCompError(error.message); return; }
    setEditCompVisible(false);
    loadCompartments();
  }

  // ── Delete compartment handlers ──────────────────────────────────────
  function openDeleteComp(Comp: Compartment) {
    setDeletingComp(Comp);
    setDeleteCompError('');
    setDeleteCompVisible(true);
  }

  async function handleDeleteComp() {
    if (!DeletingComp) return;
    setDeleteCompLoading(true);
    setDeleteCompError('');
    const { error } = await supabase.from('compartments').delete().eq('id', DeletingComp.id);
    setDeleteCompLoading(false);
    if (error) { setDeleteCompError(error.message); return; }
    setDeleteCompVisible(false);
    loadCompartments();
  }

  return (
    <>
      <View style={styles.Container}>
        <FlatList
          data={Compartments}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.List}
          ListHeaderComponent={(
            <View>
              <Text variant="bodyMedium" style={styles.Subtitle}>
                {UnitTypeLabel[UnitType] ?? UnitType}
                {DefaultHoleType ? `  ·  Default hole: ${DefaultHoleType}` : ''}
              </Text>
              <View style={styles.UnitActions}>
                <Button mode="outlined" compact onPress={openEditUnit} style={styles.ActionBtn}>
                  Edit Unit
                </Button>
                <Button
                  mode="outlined" compact textColor="red"
                  style={[styles.ActionBtn, styles.DangerBtn]}
                  onPress={() => { setDeleteUnitError(''); setDeleteUnitVisible(true); }}
                >
                  Delete Unit
                </Button>
              </View>
            </View>
          )}
          ListEmptyComponent={!Loading ? (
            <View style={styles.Empty}>
              <Text variant="titleMedium" style={styles.EmptyTitle}>No compartments yet</Text>
              <Text variant="bodyMedium" style={styles.EmptyText}>
                Tap + to add cavities to this housing unit.
              </Text>
            </View>
          ) : null}
          renderItem={({ item }) => (
            <Card style={styles.Card} mode="outlined">
              <Card.Title
                title={item.cavity_label}
                subtitle={`${item.housing_type}  ·  ${item.hole_type}`}
                right={() => (
                  <View style={styles.CardActions}>
                    <IconButton icon="pencil" size={20} onPress={() => openEditComp(item)} />
                    <IconButton icon="delete" size={20} iconColor="red" onPress={() => openDeleteComp(item)} />
                  </View>
                )}
              />
            </Card>
          )}
        />

        <FAB
          icon="plus"
          style={styles.FAB}
          onPress={() => navigation.navigate('CreateCompartment', { UnitId, UnitType, DefaultHoleType })}
        />
      </View>

      <Portal>
        {/* ── Edit Unit ──────────────────────────────────────────── */}
        <Dialog visible={EditUnitVisible} onDismiss={() => setEditUnitVisible(false)}>
          <Dialog.Title>Edit Housing Unit</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Unit name *"
              value={EditUnitName}
              onChangeText={setEditUnitName}
              style={styles.DialogInput}
            />
            <Text variant="labelMedium" style={styles.DialogLabel}>Default hole type</Text>
            <RadioButton.Group onValueChange={setEditDefaultHole} value={EditDefaultHole}>
              {HoleTypes.map((H) => <RadioButton.Item key={H.value} label={H.label} value={H.value} />)}
            </RadioButton.Group>
            {EditUnitError ? <HelperText type="error" visible>{EditUnitError}</HelperText> : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setEditUnitVisible(false)}>Cancel</Button>
            <Button loading={EditUnitLoading} onPress={handleSaveUnit}>Save</Button>
          </Dialog.Actions>
        </Dialog>

        {/* ── Delete Unit ────────────────────────────────────────── */}
        <Dialog visible={DeleteUnitVisible} onDismiss={() => setDeleteUnitVisible(false)}>
          <Dialog.Title>Delete {UnitName}?</Dialog.Title>
          <Dialog.Content>
            <Text>
              This will permanently delete this housing unit and all its compartments and
              nest check data. This cannot be undone.
            </Text>
            {DeleteUnitError ? <HelperText type="error" visible>{DeleteUnitError}</HelperText> : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteUnitVisible(false)}>Cancel</Button>
            <Button textColor="red" loading={DeleteUnitLoading} onPress={handleDeleteUnit}>Delete</Button>
          </Dialog.Actions>
        </Dialog>

        {/* ── Edit Compartment ───────────────────────────────────── */}
        <Dialog visible={EditCompVisible} onDismiss={() => setEditCompVisible(false)}>
          <Dialog.Title>Edit Compartment</Dialog.Title>
          <Dialog.ScrollArea>
            <ScrollView contentContainerStyle={styles.DialogScroll}>
              <TextInput
                label="Compartment label *"
                value={EditCompLabel}
                onChangeText={setEditCompLabel}
                style={styles.DialogInput}
              />
              {IsGourdRack && (
                <>
                  <Text variant="labelMedium" style={styles.DialogLabel}>Gourd type</Text>
                  <RadioButton.Group onValueChange={setEditCompHousing} value={EditCompHousing}>
                    {GourdTypes.map((G) => <RadioButton.Item key={G.value} label={G.label} value={G.value} />)}
                  </RadioButton.Group>
                </>
              )}
              <Button
                mode="text" compact
                style={styles.OverrideBtn}
                onPress={() => setEditCompOverride(!EditCompOverride)}
              >
                {EditCompOverride
                  ? 'Use default hole type'
                  : `Override hole type (default: ${DefaultHoleType ?? 'none'})`}
              </Button>
              {EditCompOverride && (
                <>
                  <Text variant="labelMedium" style={styles.DialogLabel}>Hole type</Text>
                  <RadioButton.Group onValueChange={setEditCompHoleType} value={EditCompHoleType}>
                    {HoleTypes.map((H) => <RadioButton.Item key={H.value} label={H.label} value={H.value} />)}
                  </RadioButton.Group>
                </>
              )}
              {EditCompError ? <HelperText type="error" visible>{EditCompError}</HelperText> : null}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setEditCompVisible(false)}>Cancel</Button>
            <Button loading={EditCompLoading} onPress={handleSaveComp}>Save</Button>
          </Dialog.Actions>
        </Dialog>

        {/* ── Delete Compartment ─────────────────────────────────── */}
        <Dialog visible={DeleteCompVisible} onDismiss={() => setDeleteCompVisible(false)}>
          <Dialog.Title>Delete "{DeletingComp?.cavity_label}"?</Dialog.Title>
          <Dialog.Content>
            <Text>
              This will permanently delete this compartment and all its nest check data.
              This cannot be undone.
            </Text>
            {DeleteCompError ? <HelperText type="error" visible>{DeleteCompError}</HelperText> : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteCompVisible(false)}>Cancel</Button>
            <Button textColor="red" loading={DeleteCompLoading} onPress={handleDeleteComp}>Delete</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  Container:    { flex: 1 },
  List:         { padding: 16 },
  Subtitle:     { color: '#555', marginBottom: 4 },
  UnitActions:  { flexDirection: 'row', paddingVertical: 8, gap: 8 },
  ActionBtn:    { flex: 1 },
  DangerBtn:    { borderColor: 'red' },
  Card:         { marginBottom: 8 },
  CardActions:  { flexDirection: 'row', alignItems: 'center', marginRight: 4 },
  Empty:        { alignItems: 'center', padding: 32 },
  EmptyTitle:   { marginBottom: 8 },
  EmptyText:    { textAlign: 'center', color: '#666' },
  FAB:          { position: 'absolute', right: 16, bottom: 16 },
  DialogInput:  { marginBottom: 8 },
  DialogLabel:  { marginTop: 12, marginBottom: 4 },
  DialogScroll: { paddingHorizontal: 24, paddingVertical: 8 },
  OverrideBtn:  { alignSelf: 'flex-start', marginTop: 8 },
});
