import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import type { PairingCode, Patient } from '../../../src/api/endpoints';
import { t } from '../../../src/i18n';
import { messageFor } from '../../../src/lib/errors';
import { formatRemaining } from '../../../src/lib/time';
import { usePolling } from '../../../src/lib/use-polling';
import { useSessionService } from '../../../src/session/provider';
import { Banner, Body, Button, Card, Heading, Loading, Screen, Spacer, Title } from '../../../src/ui/components';

const POLL_MS = 4000;

export default function PatientScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const session = useSessionService();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [connectedOn, setConnectedOn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeAtCodeTime = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const p = await session.api.patients.get(id);
      setPatient(p);
      setError(null);
      return p;
    } catch (e) {
      setError(t(messageFor(e)));
      return null;
    }
  }, [session, id]);
  useEffect(() => void load(), [load]);

  const remaining = code ? new Date(code.expires_at).getTime() - now : 0;
  const live = !!code && remaining > 0;
  usePolling(() => setNow(Date.now()), 1000, live);

  // While a code is live, watch for a phone that was not connected when the code was made (D-016): "Connected on …".
  usePolling(
    async () => {
      const p = await load();
      const fresh = p?.devices.find((d) => !d.revoked_at && !activeAtCodeTime.current.has(d.id));
      if (fresh) {
        setConnectedOn(fresh.label ?? t('patient.connected.unknown'));
        setCode(null);
      }
    },
    POLL_MS,
    live,
  );

  const makeCode = async () => {
    setBusy(true);
    setConnectedOn(null);
    try {
      activeAtCodeTime.current = new Set(patient?.devices.filter((d) => !d.revoked_at).map((d) => d.id));
      const created = await session.api.pairing.createCode(id);
      setCode(created);
      setNow(Date.now());
      setError(null);
    } catch (e) {
      setError(t(messageFor(e, { SUBSCRIPTION_INACTIVE: 'patients.subscriptionNeeded' })));
    } finally {
      setBusy(false);
    }
  };

  const revoke = (deviceId: string) =>
    Alert.alert(t('patient.devices.revoke'), t('patient.devices.confirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('patient.devices.revoke'),
        style: 'destructive',
        onPress: () => void session.api.devices.revoke(deviceId).then(load, (e: unknown) => setError(t(messageFor(e)))),
      },
    ]);

  const archive = () =>
    Alert.alert(t('patient.archive'), t('patient.archive.confirm', { name: patient?.display_name ?? '' }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('patient.archive'), style: 'destructive', onPress: () => void session.api.patients.archive(id).then(() => router.replace('/patients'), (e: unknown) => setError(t(messageFor(e)))) },
    ]);

  if (!patient) return error ? <Screen><Banner tone="danger" text={error} /></Screen> : <Loading label={t('common.loading')} />;
  const name = patient.display_name;
  const phones = patient.devices;
  return (
    <Screen>
      <Title>{name}</Title>
      {error ? <Banner tone="danger" text={error} /> : null}
      {connectedOn ? <Banner tone="ok" text={t('patient.connected', { device: connectedOn })} /> : null}

      <Card>
        <Heading>{t('patient.connect.title')}</Heading>
        <Body muted>{t('patient.connect.body', { name })}</Body>
        {live && code ? (
          <>
            <View accessibilityLabel={t('patient.connect.qrLabel')} style={{ alignItems: 'center', padding: 8 }}>
              <QRCode value={code.qr_payload} size={200} />
            </View>
            <Heading>{code.code}</Heading>
            <Body>{t('patient.connect.expires', { time: formatRemaining(remaining) })}</Body>
          </>
        ) : code ? (
          <Body>{t('patient.connect.expired')}</Body>
        ) : null}
        <Button label={code ? t('patient.connect.refresh') : phones.some((d) => d.revoked_at) ? t('patient.devices.repair') : t('patient.connect.generate')} onPress={() => void makeCode()} busy={busy} testID="make-code" />
      </Card>

      <Heading>{t('patient.devices.title')}</Heading>
      {phones.length === 0 ? <Body muted>{t('patients.devices.none')}</Body> : null}
      {phones.map((d) => (
        <Card key={d.id}>
          <Body>{d.label ?? t('patient.connected.unknown')}</Body>
          <Body muted>{d.revoked_at ? t('patient.devices.revoked') : d.healthy ? t('patient.devices.healthy') : t('patient.devices.problem')}</Body>
          {!d.revoked_at ? <Button label={t('patient.devices.revoke')} variant="danger" onPress={() => revoke(d.id)} testID={`revoke-${d.id}`} /> : null}
        </Card>
      ))}
      <Spacer />
      <Button label={t('patient.archive')} variant="secondary" onPress={archive} testID="archive" />
    </Screen>
  );
}
