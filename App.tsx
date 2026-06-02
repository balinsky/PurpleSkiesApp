import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';
import { Session } from '@supabase/supabase-js';
import { useFonts } from 'expo-font';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SettingsProvider } from './contexts/SettingsContext';
import { en, registerTranslation } from 'react-native-paper-dates';
registerTranslation('en', en);
import { supabase } from './lib/supabase';
import LoginScreen from './screens/auth/LoginScreen';
import SignUpScreen from './screens/auth/SignUpScreen';
import HomeScreen from './screens/HomeScreen';
import CreateSiteScreen from './screens/CreateSiteScreen';
import SiteDetailScreen from './screens/SiteDetailScreen';
import CreateHousingUnitScreen from './screens/CreateHousingUnitScreen';
import HousingUnitDetailScreen from './screens/HousingUnitDetailScreen';
import CreateCompartmentScreen from './screens/CreateCompartmentScreen';
import SeasonDetailScreen from './screens/SeasonDetailScreen';
import NestCheckDetailScreen from './screens/NestCheckDetailScreen';
import NestCheckEntryScreen from './screens/NestCheckEntryScreen';
import ProfileScreen from './screens/ProfileScreen';
import SiteMembersScreen from './screens/SiteMembersScreen';

enableScreens();

export type AuthStackParamList = {
  Login: undefined;
  SignUp: undefined;
};

export type AppStackParamList = {
  Home: undefined;
  Profile: undefined;
  SiteMembers: { SiteId: string; SiteName: string };
  CreateSite: undefined;
  SiteDetail: { SiteId: string; SiteName: string };
  CreateHousingUnit: { SiteId: string };
  HousingUnitDetail: { UnitId: string; UnitName: string; UnitType: string; DefaultHoleType: string | null };
  CreateCompartment: { UnitId: string; UnitType: string; DefaultHoleType: string | null };
  SeasonDetail: { SeasonId: string; SiteId: string; Year: number };
  NestCheckDetail: { CheckId: string; CheckDate: string; SiteId: string; SeasonId: string; Year: number };
  NestCheckEntry: { CheckId: string; CheckDate: string; SeasonId: string; SiteId: string; CompartmentId: string; CompartmentLabel: string; UnitName: string; ExistingEntryId: string | null; AllCompartments?: { id: string; cavity_label: string; unit_name: string; entry_id: string | null }[]; CompartmentIndex?: number };
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const AppStack = createNativeStackNavigator<AppStackParamList>();

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="SignUp" component={SignUpScreen} />
    </AuthStack.Navigator>
  );
}

function AppNavigator() {
  return (
    <AppStack.Navigator>
      <AppStack.Screen name="Home" component={HomeScreen} options={{ title: 'Purple Skies' }} />
      <AppStack.Screen name="Profile" component={ProfileScreen} options={{ title: 'My Profile' }} />
      <AppStack.Screen name="SiteMembers" component={SiteMembersScreen} options={{ title: 'Members' }} />
      <AppStack.Screen name="CreateSite" component={CreateSiteScreen} options={{ title: 'New Site' }} />
      <AppStack.Screen name="SiteDetail" component={SiteDetailScreen} options={({ route }) => ({ title: route.params.SiteName })} />
      <AppStack.Screen name="CreateHousingUnit" component={CreateHousingUnitScreen} options={{ title: 'Add Housing Unit' }} />
      <AppStack.Screen name="HousingUnitDetail" component={HousingUnitDetailScreen} options={({ route }) => ({ title: route.params.UnitName })} />
      <AppStack.Screen name="CreateCompartment" component={CreateCompartmentScreen} options={{ title: 'Add Compartment' }} />
      <AppStack.Screen name="SeasonDetail" component={SeasonDetailScreen} options={({ route }) => ({ title: `${route.params.Year} Season` })} />
      <AppStack.Screen name="NestCheckDetail" component={NestCheckDetailScreen} options={({ route }) => ({ title: new Date(route.params.CheckDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) })} />
      <AppStack.Screen name="NestCheckEntry" component={NestCheckEntryScreen} options={({ route }) => ({ title: `${route.params.UnitName} · ${route.params.CompartmentLabel}` })} />
    </AppStack.Navigator>
  );
}


export default function App() {
  const [Session, setSession] = useState<Session | null>(null);
  const [Loading, setLoading] = useState(true);
  const [FontsLoaded] = useFonts(MaterialCommunityIcons.font);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
      if (session?.user) void acceptPendingInvitations(session.user.id, session.user.email ?? '');
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      if (event === 'SIGNED_IN' && session?.user) {
        void acceptPendingInvitations(session.user.id, session.user.email ?? '');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  if (Loading || !FontsLoaded) return null;

  return (
    <SafeAreaProvider>
      <PaperProvider>
        <SettingsProvider>
          <NavigationContainer>
            {Session ? <AppNavigator /> : <AuthNavigator />}
          </NavigationContainer>
        </SettingsProvider>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
