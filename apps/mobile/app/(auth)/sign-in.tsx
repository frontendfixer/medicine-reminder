import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { t } from '../../src/i18n';
import { messageFor } from '../../src/lib/errors';
import { looksLikeEmail } from '../../src/lib/validation';
import { useSession, useSessionService } from '../../src/session/provider';
import { Banner, Body, Button, Field, Screen, Spacer, Title } from '../../src/ui/components';

export default function SignIn() {
  const router = useRouter();
  const session = useSessionService();
  const { notice } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!looksLikeEmail(email) || !password) return setError(t('auth.error.invalid'));
    setBusy(true);
    try {
      await session.signIn(email.trim().toLowerCase(), password);
      router.replace('/');
    } catch (e) {
      setError(t(messageFor(e, { INVALID_CREDENTIALS: 'auth.error.invalid' })));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>{t('auth.signIn.title')}</Title>
      {notice === 'replaced' ? <Banner text={`${t('auth.replaced.title')}. ${t('auth.replaced.body')}`} /> : null}
      {notice === 'expired' ? <Banner text={t('auth.expired.body')} /> : null}
      <Field label={t('auth.email')} value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" testID="email" />
      <Field label={t('auth.password')} value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" testID="password" error={error} />
      <Button label={t('auth.signIn.submit')} onPress={() => void submit()} busy={busy} testID="submit" />
      <Spacer />
      <Link href="/register" asChild>
        <Body>{t('auth.signIn.toRegister')}</Body>
      </Link>
    </Screen>
  );
}
