import { Redirect, Stack } from 'expo-router';
import { useSession } from '../../src/session/provider';

// A phone that is not paired has nothing to show here.
export default function PatientLayout() {
  const { patient } = useSession();
  if (!patient) return <Redirect href="/pair" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
