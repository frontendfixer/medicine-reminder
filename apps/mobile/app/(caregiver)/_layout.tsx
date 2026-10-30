import { Redirect, Stack } from 'expo-router';
import { t } from '../../src/i18n';
import { useSession } from '../../src/session/provider';

// Everything in here needs a signed-in caregiver. If the session ends (another phone signed in, or it expired), the
// guard sends the person to sign-in, where a notice explains why.
export default function CaregiverLayout() {
  const { caregiver } = useSession();
  if (!caregiver) return <Redirect href="/sign-in" />;
  return <Stack screenOptions={{ headerTitle: t('app.name'), headerBackTitle: t('common.back') }} />;
}
