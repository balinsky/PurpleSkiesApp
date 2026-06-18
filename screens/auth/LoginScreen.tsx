import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Text, TextInput, HelperText } from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../../lib/supabase';
import { friendlyAuthError } from '../../lib/errorUtils';
import { AuthStackParamList } from '../../App';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Login'>;
};

export default function LoginScreen({ navigation }: Props) {
  const [Email, setEmail] = useState('');
  const [Password, setPassword] = useState('');
  const [Loading, setLoading] = useState(false);
  const [ErrorMessage, setErrorMessage] = useState('');

  async function handleLogin() {
    setErrorMessage('');
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: Email, password: Password });
    setLoading(false);
    if (error) {
      if (error.message.toLowerCase().includes('email not confirmed')) {
        setErrorMessage('Please confirm your email address before logging in. Check your inbox.');
      } else {
        setErrorMessage(friendlyAuthError(error));
      }
    }
  }

  return (
    <View style={styles.Container}>
      <Text variant="headlineMedium" style={styles.Title}>Purple Skies</Text>
      <TextInput
        label="Email"
        value={Email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        maxLength={200}
        style={styles.Input}
      />
      <TextInput
        label="Password"
        value={Password}
        onChangeText={setPassword}
        secureTextEntry
        maxLength={128}
        style={styles.Input}
      />
      {ErrorMessage ? <HelperText type="error" visible>{ErrorMessage}</HelperText> : null}
      <Button mode="contained" onPress={handleLogin} loading={Loading} style={styles.Button}>
        Log In
      </Button>
      <Button mode="text" onPress={() => navigation.navigate('SignUp')}>
        Don't have an account? Sign up
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  Container: { flex: 1, justifyContent: 'center', padding: 24 },
  Title:     { textAlign: 'center', marginBottom: 32 },
  Input:     { marginBottom: 12 },
  Button:    { marginTop: 8, marginBottom: 4 },
});
