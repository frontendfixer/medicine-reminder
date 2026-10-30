import { t } from '../../src/i18n';
import { Banner, Body, Screen, Title } from '../../src/ui/components';

export default function Notice() {
  return (
    <Screen>
      <Title>{t('notice.title')}</Title>
      <Banner text={t('notice.draft')} />
      <Body>{t('notice.body')}</Body>
    </Screen>
  );
}
