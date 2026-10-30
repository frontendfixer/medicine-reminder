import { useRouter } from 'expo-router';
import { t } from '../src/i18n';
import { useSessionService } from '../src/session/provider';
import { Body, Button, Card, Heading, Screen, Title } from '../src/ui/components';

// One app, two modes (D-001). A phone can hold both, so switching later keeps the other side signed in.
export default function ChooseMode() {
  const router = useRouter();
  const session = useSessionService();
  const choose = async (mode: 'caregiver' | 'patient') => {
    await session.setMode(mode);
    router.replace('/');
  };
  return (
    <Screen>
      <Title>{t('mode.title')}</Title>
      <Card>
        <Heading>{t('mode.caregiver.title')}</Heading>
        <Body muted>{t('mode.caregiver.body')}</Body>
        <Button label={t('mode.caregiver.title')} onPress={() => void choose('caregiver')} testID="mode-caregiver" />
      </Card>
      <Card>
        <Heading>{t('mode.patient.title')}</Heading>
        <Body muted>{t('mode.patient.body')}</Body>
        <Button label={t('mode.patient.title')} onPress={() => void choose('patient')} testID="mode-patient" />
      </Card>
    </Screen>
  );
}
