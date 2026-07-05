import React, { useState } from 'react';
import { Divider, IconButton, Menu } from 'react-native-paper';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AppStackParamList } from '../App';

type Props = {
  navigation: NativeStackNavigationProp<AppStackParamList>;
  onDelete?: () => void;
  deleteLabel?: string;
};

export default function HeaderMenu({ navigation, onDelete, deleteLabel = 'Delete' }: Props) {
  const [Visible, setVisible] = useState(false);

  return (
    <Menu
      visible={Visible}
      onDismiss={() => setVisible(false)}
      anchor={
        <IconButton
          icon="dots-vertical"
          size={24}
          onPress={() => setVisible(true)}
          style={{ marginRight: 4 }}
        />
      }
    >
      <Menu.Item
        leadingIcon="account-circle-outline"
        onPress={() => { setVisible(false); navigation.navigate('Profile'); }}
        title="Profile"
      />
      <Menu.Item
        leadingIcon="cog-outline"
        onPress={() => { setVisible(false); navigation.navigate('Settings'); }}
        title="Settings"
      />
      {onDelete ? (
        <>
          <Divider />
          <Menu.Item
            leadingIcon="trash-can-outline"
            onPress={() => { setVisible(false); onDelete(); }}
            title={deleteLabel}
            titleStyle={{ color: 'red' }}
          />
        </>
      ) : null}
    </Menu>
  );
}
