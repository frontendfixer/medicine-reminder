import { useRouter } from 'expo-router';
import { t } from '../../src/i18n';
import { Body, Button, Screen, Title } from '../../src/ui/components';

// The server no longer accepts this phone (revoked, D-015). One screen, one way forward. Alarms already scheduled on
// the phone are not touched, so reminders keep ringing until a new code is entered.
export default function Rejected() {
  const router = useRouter();
  return (
    <Screen>
      <Title>{t('rejected.title')}</Title>
      <Body>{t('rejected.body')}</Body>
      <Button label={t('rejected.enter')} onPress={() => router.replace('/pair')} testID="enter-code" />
    </Screen>
  );
}
