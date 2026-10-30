import { Redirect } from 'expo-router';
import { t } from '../src/i18n';
import { useSession } from '../src/session/provider';
import { Loading } from '../src/ui/components';

// Decides where the app opens: the mode, then whether that mode is signed in or paired.
export default function Entry() {
  const s = useSession();
  if (!s.ready) return <Loading label={t('common.loading')} />;
  if (s.upgradeRequired) return <Redirect href="/upgrade" />;
  if (!s.mode) return <Redirect href="/mode" />;
  if (s.mode === 'caregiver') return <Redirect href={s.caregiver ? '/patients' : '/sign-in'} />;
  if (!s.patient) return <Redirect href="/pair" />;
  return <Redirect href={s.deviceRejected ? '/rejected' : '/today'} />;
}
