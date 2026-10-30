import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { t } from '../../../src/i18n';
import type { Patient } from '../../../src/api/endpoints';
import { messageFor } from '../../../src/lib/errors';
import { useSessionService } from '../../../src/session/provider';
import { Banner, Body, Button, Card, Heading, Loading, Screen, Spacer, Title } from '../../../src/ui/components';

export default function Patients() {
  const router = useRouter();
  const session = useSessionService();
  const [patients, setPatients] = useState<Patient[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    session.api.patients.list().then(
      (r) => live && (setPatients(r.items), setError(null)),
      (e: unknown) => live && setError(t(messageFor(e))),
    );
    return () => void (live = false);
  }, [session]);
  useFocusEffect(load);

  if (!patients && !error) return <Loading label={t('common.loading')} />;
  return (
    <Screen>
      <Title>{t('patients.title')}</Title>
      {error ? <Banner tone="danger" text={error} /> : null}
      {error ? <Button label={t('common.retry')} variant="secondary" onPress={() => void load()} testID="retry" /> : null}
      {patients?.length === 0 ? <Body muted>{t('patients.empty')}</Body> : null}
      {patients?.map((p) => {
        const phones = p.devices.filter((d) => !d.revoked_at).length;
        return (
          <Card key={p.id} onPress={() => router.push(`/patients/${p.id}`)} label={p.display_name} testID={`patient-${p.id}`}>
            <Heading>{p.display_name}</Heading>
            {p.status !== 'active' ? <Body muted>{t(p.status === 'archived' ? 'patients.status.archived' : 'patients.status.suspended')}</Body> : null}
            <Body muted>{phones > 0 ? t('patients.devices.count', { count: phones }) : t('patients.devices.none')}</Body>
          </Card>
        );
      })}
      <Spacer />
      <Button label={t('patients.add')} onPress={() => router.push('/patients/new')} testID="add-patient" />
      <Button label={t('mode.switch')} variant="secondary" onPress={() => void session.setMode(null).then(() => router.replace('/'))} testID="switch-mode" />
      <Button label={t('common.signOut')} variant="secondary" onPress={() => void session.signOut()} testID="sign-out" />
    </Screen>
  );
}
