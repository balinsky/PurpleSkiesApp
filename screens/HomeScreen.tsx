import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Card, FAB, Text } from 'react-native-paper';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { AppStackParamList } from '../App';

type Site = { id: string; name: string; address: string | null };

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList, 'Home'>;
};

export default function HomeScreen({ navigation }: Props) {
  const [Sites, setSites] = useState<Site[]>([]);
  const [Loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      async function fetchSites() {
        setLoading(true);
        const { data } = await supabase.from('sites').select('id, name, address').order('name');
        setSites(data ?? []);
        setLoading(false);
      }
      fetchSites();
    }, [])
  );

  return (
    <View style={styles.Container}>
      {!Loading && Sites.length === 0 ? (
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
  Container: { flex: 1 },
  List:      { padding: 16 },
  Card:      { marginBottom: 12 },
  Empty:     { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  EmptyTitle:{ marginBottom: 8 },
  EmptyText: { textAlign: 'center', color: '#666' },
  FAB:       { position: 'absolute', right: 16, bottom: 16 },
});
