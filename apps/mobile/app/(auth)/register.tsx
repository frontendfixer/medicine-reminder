import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { ApiError } from '../../src/api/http';
import { t } from '../../src/i18n';
import { messageFor } from '../../src/lib/errors';
import { looksLikeEmail, passwordLongEnough } from '../../src/lib/validation';
import { NOTICE_VERSION, useSessionService } from '../../src/session/provider';
import { Body, Button, Check, Field, Screen, Spacer, Title } from '../../src/ui/components';

export default function Register() {
  const router = useRouter();
  const session = useSessionService();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; consent?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const found: typeof errors = {};
    if (!looksLikeEmail(email)) found.email = t('auth.error.email');
    if (!passwordLongEnough(password)) found.password = t('auth.error.passwordShort');
    if (!agreed) found.consent = t('auth.error.consentRequired');
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await session.register(email.trim().toLowerCase(), password, NOTICE_VERSION);
      router.replace('/');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'EMAIL_TAKEN') setErrors({ email: t('auth.error.emailTaken') });
      else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') setErrors({ email: e.fields.email ? t('auth.error.email') : undefined, password: e.fields.password ? t('auth.error.passwordShort') : undefined });
      else setErrors({ form: t(messageFor(e)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>{t('auth.register.title')}</Title>
      <Field label={t('auth.email')} value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" error={errors.email} testID="email" />
      <Field label={`${t('auth.password')} (${t('auth.password.hint')})`} value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" error={errors.password} testID="password" />
      <Check label={t('auth.consent.label')} value={agreed} onChange={setAgreed} error={errors.consent} />
      <Link href="/notice" asChild>
        <Body>{t('auth.consent.read')}</Body>
      </Link>
      {errors.form ? <Body>{errors.form}</Body> : null}
      <Button label={t('auth.register.submit')} onPress={() => void submit()} busy={busy} testID="submit" />
      <Spacer />
      <Link href="/sign-in" asChild>
        <Body>{t('auth.register.toSignIn')}</Body>
      </Link>
    </Screen>
  );
}
