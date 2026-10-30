import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { t } from '../../src/i18n';
import { localTime } from '../../src/lib/time';
import { useToday } from '../../src/reminders/use-today';
import { SNOOZE_MS, type LocalDose } from '../../src/reminders/store';
import { useSession, useSessionService } from '../../src/session/provider';
import { Banner, Body, Button, Card, Heading, Loading, Screen, Title } from '../../src/ui/components';

const DAY = 86_400_000;

// The patient's day. Large buttons for the three answers (D-029). It reads what is stored on the phone first, so it works
// with no connection and no notification permission (D-077); the server's version arrives in the background.
export default function Today() {
  const router = useRouter();
  const session = useSessionService();
  const { deviceRejected, patient } = useSession();
  const today = useToday();
  const [now, setNow] = useState(Date.now());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000); // so Snooze disappears when it would pass the deadline
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (deviceRejected) router.replace('/rejected');
  }, [deviceRejected, router]);
  if (deviceRejected) return null;
  if (!today.loaded) return <Loading label={t('common.loading')} />;

  const zone = patient?.timezone ?? 'UTC';
  const shown = today.doses.filter((d) => d.scheduledAt > now - DAY && d.scheduledAt < now + DAY);
  const answer = async (d: LocalDose, action: 'taken' | 'not_taken' | 'snooze') => {
    setFailed(false);
    const r = await today.answer(d.id, action);
    if (r && !r.ok && r.reason !== 'already_answered') setFailed(true);
  };

  return (
    <Screen>
      <Title>{t('today.title')}</Title>
      {patient ? <Body muted>{patient.displayName}</Body> : null}
      {today.errorKey ? <Banner tone="danger" text={t(today.errorKey)} /> : null}
      {failed ? <Banner tone="danger" text={t('today.error.answer')} /> : null}
      {today.unsent ? <Banner tone="ok" text={t('today.offline')} /> : null}
      {today.accountState === 'suspended' ? <Banner text={t('today.paused')} /> : null}
      {today.accountState === 'grace' ? <Banner text={t('today.grace')} /> : null}
      {shown.length === 0 && today.accountState !== 'suspended' ? <Body muted>{t('today.empty')}</Body> : null}
      {shown.map((d) => {
        const answered = d.status === 'taken' || d.status === 'not_taken';
        const canSnooze = !answered && now + SNOOZE_MS < d.alertDueAt;
        return (
          <Card key={d.id}>
            <Heading>{d.name}</Heading>
            <Body>{d.amount}</Body>
            <Body muted>{`${t('today.at', { time: localTime(new Date(d.scheduledAt).toISOString(), zone) })} · ${t(`today.status.${d.status}` as 'today.status.pending')}`}</Body>
            {d.status === 'snoozed' && d.snoozeUntil ? <Body muted>{t('today.snoozedUntil', { time: localTime(new Date(d.snoozeUntil).toISOString(), zone) })}</Body> : null}
            {!answered && d.status !== 'missed' ? (
              <View style={{ gap: 12 }}>
                <Button label={t('today.action.taken')} onPress={() => void answer(d, 'taken')} testID={`taken-${d.id}`} />
                <Button label={t('today.action.notTaken')} variant="secondary" onPress={() => void answer(d, 'not_taken')} testID={`not-taken-${d.id}`} />
                {canSnooze ? <Button label={t('today.action.snooze')} variant="secondary" onPress={() => void answer(d, 'snooze')} testID={`snooze-${d.id}`} /> : null}
              </View>
            ) : null}
            {d.status === 'missed' ? (
              <View style={{ gap: 12 }}>
                <Button label={t('today.action.taken')} onPress={() => void answer(d, 'taken')} testID={`taken-${d.id}`} />
                <Button label={t('today.action.notTaken')} variant="secondary" onPress={() => void answer(d, 'not_taken')} testID={`not-taken-${d.id}`} />
              </View>
            ) : null}
            {answered ? <Body>{t('today.answered', { answer: t(`today.status.${d.status}` as 'today.status.taken') })}</Body> : null}
          </Card>
        );
      })}
      <Button label={t('today.refresh')} variant="secondary" onPress={() => void today.sync()} busy={today.syncing} testID="refresh" />
      <Button label={t('mode.switch')} variant="secondary" onPress={() => void session.setMode(null).then(() => router.replace('/'))} testID="switch-mode" />
    </Screen>
  );
}
