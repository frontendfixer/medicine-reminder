import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import type { SyncResult } from '../../src/api/endpoints';
import { t } from '../../src/i18n';
import { messageFor } from '../../src/lib/errors';
import { localTime } from '../../src/lib/time';
import { useSession, useSessionService } from '../../src/session/provider';
import { Banner, Body, Button, Card, Heading, Loading, Screen, Title } from '../../src/ui/components';

// The Today screen. This first version reads what the server issued; answering from here and from the lock screen comes
// with the local outbox and the notification scheduler.
export default function Today() {
  const router = useRouter();
  const session = useSessionService();
  const { deviceRejected, patient } = useSession();
  const [data, setData] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await session.api.device.sync());
      setError(null);
    } catch (e) {
      setError(t(messageFor(e)));
    }
  }, [session]);
  useFocusEffect(useCallback(() => void load(), [load]));

  if (deviceRejected) {
    router.replace('/rejected');
    return null;
  }
  if (!data && !error) return <Loading label={t('common.loading')} />;
  const zone = data?.patient.timezone ?? patient?.timezone ?? 'UTC';
  return (
    <Screen>
      <Title>{t('today.title')}</Title>
      {data ? <Body muted>{data.patient.display_name}</Body> : null}
      {error ? <Banner tone="danger" text={error} /> : null}
      {error ? <Button label={t('common.retry')} variant="secondary" onPress={() => void load()} testID="retry" /> : null}
      {data?.account_state === 'suspended' ? <Banner text={t('today.paused')} /> : null}
      {data?.account_state === 'grace' ? <Banner text={t('today.grace')} /> : null}
      {data && data.doses.length === 0 && data.account_state !== 'suspended' ? <Body muted>{t('today.empty')}</Body> : null}
      {data?.doses.map((d) => (
        <Card key={d.id}>
          <Heading>{d.name}</Heading>
          <Body>{d.amount}</Body>
          <Body muted>{`${t('today.at', { time: localTime(d.scheduled_at, zone) })} · ${t(`today.status.${d.status}` as 'today.status.pending')}`}</Body>
        </Card>
      ))}
      <Button label={t('today.refresh')} variant="secondary" onPress={() => void load()} testID="refresh" />
      <Button label={t('mode.switch')} variant="secondary" onPress={() => void session.setMode(null).then(() => router.replace('/'))} testID="switch-mode" />
    </Screen>
  );
}
