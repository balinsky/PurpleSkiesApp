import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Text, TextInput, HelperText } from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../../lib/supabase';
import { friendlyAuthError } from '../../lib/errorUtils';
import { AuthStackParamList } from '../../App';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'SignUp'>;
};

export default function SignUpScreen({ navigation }: Props) {
  const [Name, setName] = useState('');
  const [Email, setEmail] = useState('');
  const [Password, setPassword] = useState('');
  const [Loading, setLoading] = useState(false);
  const [ErrorMessage, setErrorMessage] = useState('');
  const [Success, setSuccess] = useState(false);

  async function handleSignUp() {
    setErrorMessage('');
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email: Email,
      password: Password,
      options: { data: { name: Name } },
    });
    setLoading(false);
    if (error) {
      setErrorMessage(friendlyAuthError(error));
    } else {
      setSuccess(true);
    }
  }

  if (Success) {
    return (
      <View style={styles.Container}>
        <Text variant="headlineMedium" style={styles.Title}>Check your email</Text>
        <Text variant="bodyMedium" style={styles.Message}>
          We sent a confirmation link to {Email}. Click it to activate your account, then log in.
        </Text>
        <Button mode="contained" onPress={() => navigation.navigate('Login')} style={styles.Button}>
          Go to Log In
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.Container}>
      <Text variant="headlineMedium" style={styles.Title}>Create Account</Text>
      <TextInput
        label="Your name (optional)"
        value={Name}
        onChangeText={setName}
        autoCapitalize="words"
        style={styles.Input}
      />
      <TextInput
        label="Email"
        value={Email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        style={styles.Input}
      />
      <TextInput
        label="Password"
        value={Password}
        onChangeText={setPassword}
        secureTextEntry
        style={styles.Input}
      />
      {ErrorMessage ? <HelperText type="error" visible>{ErrorMessage}</HelperText> : null}
      <Button mode="contained" onPress={handleSignUp} loading={Loading} style={styles.Button}>
        Sign Up
      </Button>
      <Button mode="text" onPress={() => navigation.navigate('Login')}>
        Already have an account? Log in
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  Container: { flex: 1, justifyContent: 'center', padding: 24 },
  Title:     { textAlign: 'center', marginBottom: 32 },
  Message:   { textAlign: 'center', marginBottom: 32, color: '#444' },
  Input:     { marginBottom: 12 },
  Button:    { marginTop: 8, marginBottom: 4 },
});
