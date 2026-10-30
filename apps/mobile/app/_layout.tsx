import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '../src/i18n';
import { RemindersBoot } from '../src/reminders/boot';
import { RemindersProvider } from '../src/reminders/provider';
import { SessionProvider } from '../src/session/provider';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <RemindersProvider>
          <StatusBar style="dark" />
          <RemindersBoot />
          <Stack screenOptions={{ headerShown: false }} />
        </RemindersProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
