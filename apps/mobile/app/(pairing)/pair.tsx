import { parseQrPayload } from '@med/shared';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { ApiError } from '../../src/api/http';
import { t } from '../../src/i18n';
import { messageFor } from '../../src/lib/errors';
import { NOTICE_VERSION, useSessionService } from '../../src/session/provider';
import { Banner, Body, Button, Field, Screen, Spacer, Title } from '../../src/ui/components';

type Step = 'consent' | 'choose' | 'scan' | 'type';

// The patient's own consent comes first: without it there is no pairing (docs/10-security-privacy.md#consent).
export default function Pair() {
  const router = useRouter();
  const session = useSessionService();
  const [step, setStep] = useState<Step>('consent');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false); // the scanner fires many times for one code

  const connect = async (raw: string) => {
    setError(null);
    setBusy(true);
    try {
      await session.pair(raw, NOTICE_VERSION);
      router.replace('/');
    } catch (e) {
      setError(
        t(
          messageFor(e, {
            CODE_INVALID: 'pair.error.invalid',
            CODE_EXPIRED_OR_USED: 'pair.error.expired',
            DEVICE_LIMIT_REACHED: 'pair.error.deviceLimit',
            PATIENT_SUSPENDED: 'pair.error.suspended',
            SUBSCRIPTION_INACTIVE: 'pair.error.suspended',
            PATIENT_ARCHIVED: 'pair.error.expired',
          }),
        ),
      );
      handled.current = false;
      if (e instanceof ApiError && e.code === 'NETWORK') setStep((s) => s);
    } finally {
      setBusy(false);
    }
  };

  const onScanned = ({ data }: { data: string }) => {
    if (handled.current) return;
    const parsed = parseQrPayload(data);
    if (!parsed || parsed.kind !== 'pair') {
      handled.current = true;
      setError(t('pair.error.notOurCode'));
      setTimeout(() => (handled.current = false), 2000); // let them aim at another code
      return;
    }
    handled.current = true;
    void connect(parsed.code);
  };

  if (step === 'consent') {
    return (
      <Screen>
        <Title>{t('pair.consent.title')}</Title>
        <Body>{t('pair.consent.body')}</Body>
        <Button label={t('pair.consent.agree')} onPress={() => setStep('choose')} testID="agree" />
      </Screen>
    );
  }

  if (step === 'scan') {
    return (
      <Screen scroll={false}>
        <Title>{t('pair.scan')}</Title>
        {error ? <Banner tone="danger" text={error} /> : null}
        {permission?.granted ? (
          <View style={{ flex: 1, borderRadius: 16, overflow: 'hidden' }}>
            <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScanned} />
          </View>
        ) : (
          <>
            <Body>{t('pair.camera.denied')}</Body>
            <Button label={t('pair.camera.allow')} onPress={() => void requestPermission()} testID="allow-camera" />
          </>
        )}
        <Spacer />
        <Button label={t('pair.type')} variant="secondary" onPress={() => setStep('type')} testID="to-type" />
      </Screen>
    );
  }

  if (step === 'type') {
    return (
      <Screen>
        <Title>{t('pair.type')}</Title>
        <Field label={t('pair.code.label')} placeholder={t('pair.code.placeholder')} value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} maxLength={9} error={error} testID="code" />
        <Button label={t('pair.submit')} onPress={() => void connect(code)} busy={busy} disabled={code.trim().length === 0} testID="submit" />
        <Button label={t('pair.scan')} variant="secondary" onPress={() => setStep('scan')} testID="to-scan" />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>{t('pair.title')}</Title>
      <Button label={t('pair.scan')} onPress={() => setStep('scan')} testID="choose-scan" />
      <Button label={t('pair.type')} variant="secondary" onPress={() => setStep('type')} testID="choose-type" />
    </Screen>
  );
}
