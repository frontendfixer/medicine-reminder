import { t } from '../src/i18n';
import { Body, Screen, Title } from '../src/ui/components';

// Forced update (D-080). It blocks syncing and editing but cancels nothing: alarms already on the phone keep ringing.
export default function Upgrade() {
  return (
    <Screen>
      <Title>{t('upgrade.title')}</Title>
      <Body>{t('upgrade.body')}</Body>
    </Screen>
  );
}
