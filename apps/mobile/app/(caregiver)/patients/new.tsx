import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ApiError } from '../../../src/api/http';
import { t } from '../../../src/i18n';
import { messageFor } from '../../../src/lib/errors';
import { useSessionService } from '../../../src/session/provider';
import { Banner, Button, Check, Field, Screen, Title } from '../../../src/ui/components';

export default function NewPatient() {
  const router = useRouter();
  const session = useSessionService();
  const [name, setName] = useState('');
  const [forMe, setForMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setNameError(null);
    if (!name.trim()) return setNameError(t('patientNew.error.name'));
    setBusy(true);
    try {
      // The patient follows their phone's time zone by default (D-040); the phone reports it.
      const created = await session.api.patients.create({ display_name: name.trim(), type: forMe ? 'self' : 'managed', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
      router.replace(`/patients/${created.id}`);
    } catch (e) {
      const limit = e instanceof ApiError && e.code === 'PATIENT_LIMIT_REACHED' ? (e.details.limit as number | undefined) : undefined;
      setError(limit !== undefined ? t('patients.limit', { limit }) : t(messageFor(e, { SUBSCRIPTION_INACTIVE: 'patients.subscriptionNeeded' })));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>{t('patientNew.title')}</Title>
      <Field label={t('patientNew.name')} value={name} onChangeText={setName} autoCapitalize="words" error={nameError} testID="name" />
      <Check label={t('patientNew.self')} value={forMe} onChange={setForMe} />
      {error ? <Banner tone="danger" text={error} /> : null}
      <Button label={t('patientNew.submit')} onPress={() => void submit()} busy={busy} testID="submit" />
    </Screen>
  );
}
