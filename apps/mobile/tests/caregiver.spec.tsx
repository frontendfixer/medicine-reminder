import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { params, router } from '../src/testing/expo-router-mock';
import { apiError, caregiverTokens, json, makeService, renderScreen, type Handler } from '../src/testing/render';
import CaregiverLayout from '../app/(caregiver)/_layout';
import NewPatient from '../app/(caregiver)/patients/new';
import PatientScreen from '../app/(caregiver)/patients/[id]';
import Patients from '../app/(caregiver)/patients/index';

jest.mock('expo-router', () => require('../src/testing/expo-router-mock'));
jest.mock('react-native-qrcode-svg', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: ({ value }: { value: string }) => <Text testID="qr">{value}</Text> };
});
beforeEach(() => {
  jest.clearAllMocks();
  params.id = 'p1';
});

const phone = (over: object = {}) => ({ id: 'd1', platform: 'android', label: 'Pixel 8', app_version: '1', last_seen_at: null, scheduled_through: null, healthy: true, problems: [], created_at: '', revoked_at: null, ...over });
const patient = (over: object = {}) => ({ id: 'p1', display_name: 'Asha', type: 'managed', timezone: 'Asia/Kolkata', tz_mode: 'follow_device', missed_delay_min: null, lockscreen_detail: null, status: 'active', devices: [], created_at: '', ...over });
async function signedIn(handler: Handler) {
  const made = makeService((path, init) => (path.includes('/auth/login') ? json(200, caregiverTokens) : handler(path, init)));
  await made.service.load();
  await made.service.signIn('a@b.co', 'pw');
  return made;
}

describe('guard', () => {
  it('sends a signed-out person to sign in', async () => {
    const { service } = makeService();
    await renderScreen(<CaregiverLayout />, service);
    expect(screen.getByTestId('redirect').props.children).toBe('/sign-in');
  });
});

describe('patient list', () => {
  it('shows each patient with their status and how many phones are connected', async () => {
    const { service } = await signedIn(() =>
      json(200, { items: [patient({ devices: [phone(), phone({ id: 'd2', revoked_at: 'x' })] }), patient({ id: 'p2', display_name: 'Ravi', status: 'suspended' })] }),
    );
    await renderScreen(<Patients />, service, { load: false });
    expect(await screen.findByText('Asha')).toBeTruthy();
    expect(screen.getByText('1 connected')).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByText('No phone connected')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('patient-p1'));
    expect(router.push).toHaveBeenCalledWith('/patients/p1');
  });

  it('invites the first patient, and offers a retry when the server cannot be reached', async () => {
    const empty = await signedIn(() => json(200, { items: [] }));
    await renderScreen(<Patients />, empty.service, { load: false });
    expect(await screen.findByText(/No patients yet/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('add-patient'));
    expect(router.push).toHaveBeenCalledWith('/patients/new');
  });

  it('shows a calm error with a retry button', async () => {
    let up = false;
    const { service } = await signedIn(() => (up ? json(200, { items: [patient()] }) : apiError(500, 'INTERNAL')));
    await renderScreen(<Patients />, service, { load: false });
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeTruthy();
    up = true;
    await fireEvent.press(screen.getByTestId('retry'));
    expect(await screen.findByText('Asha')).toBeTruthy();
  });

  it('can switch mode and sign out', async () => {
    const { service } = await signedIn(() => json(200, { items: [] }));
    await renderScreen(<Patients />, service, { load: false });
    await screen.findByText(/No patients yet/);
    await fireEvent.press(screen.getByTestId('switch-mode'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(service.getState().mode).toBeNull();
    await fireEvent.press(screen.getByTestId('sign-out'));
    await waitFor(() => expect(service.getState().caregiver).toBeNull());
  });
});

describe('add a patient', () => {
  it('needs a name, then opens the new patient', async () => {
    const { service, requests } = await signedIn(() => json(201, patient({ id: 'new1' })));
    await renderScreen(<NewPatient />, service, { load: false });
    await fireEvent.press(screen.getByTestId('submit'));
    expect(await screen.findByText('Enter a name.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('name'), '  Asha  ');
    await fireEvent.press(screen.getByTestId('submit'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/patients/new1'));
    const call = requests.find((r) => r.path === '/v1/patients')!;
    expect(call.body).toMatchObject({ display_name: 'Asha', type: 'managed' });
    expect(call.body.timezone).toEqual(expect.any(String));
    expect(call.headers['Idempotency-Key']).toBeTruthy();
  });

  it('can add the person’s own profile', async () => {
    const { service, requests } = await signedIn(() => json(201, patient()));
    await renderScreen(<NewPatient />, service, { load: false });
    await fireEvent.changeText(screen.getByTestId('name'), 'Me');
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByTestId('submit'));
    await waitFor(() => expect(requests.find((r) => r.path === '/v1/patients')!.body.type).toBe('self'));
  });

  it('explains the plan limit and a missing subscription', async () => {
    const limited = await signedIn(() => apiError(409, 'PATIENT_LIMIT_REACHED', { limit: 3 }));
    await renderScreen(<NewPatient />, limited.service, { load: false });
    await fireEvent.changeText(screen.getByTestId('name'), 'Asha');
    await fireEvent.press(screen.getByTestId('submit'));
    expect(await screen.findByText('Your plan allows 3 patients.')).toBeTruthy();
  });

  it('explains a missing subscription', async () => {
    const none = await signedIn(() => apiError(403, 'SUBSCRIPTION_INACTIVE'));
    await renderScreen(<NewPatient />, none.service, { load: false });
    await fireEvent.changeText(screen.getByTestId('name'), 'Asha');
    await fireEvent.press(screen.getByTestId('submit'));
    expect(await screen.findByText('An active subscription is needed to add patients.')).toBeTruthy();
  });
});

describe('connect a phone', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const codeAt = (msFromNow: number) => ({ code: 'ABCD-2345', qr_payload: 'medremind://pair?c=ABCD2345', expires_at: new Date(Date.now() + msFromNow).toISOString() });

  it('shows the code, the QR and a countdown, then says when it has expired', async () => {
    const { service, requests } = await signedIn((path) => (path.endsWith('/pairing-code') ? json(201, codeAt(10 * 60_000)) : json(200, patient())));
    await renderScreen(<PatientScreen />, service, { load: false });
    await fireEvent.press(await screen.findByTestId('make-code'));
    expect(await screen.findByText('ABCD-2345')).toBeTruthy();
    expect(screen.getByTestId('qr').props.children).toBe('medremind://pair?c=ABCD2345');
    expect(screen.getByText(/Expires in 10:00/)).toBeTruthy();
    expect(requests.some((r) => r.path === '/v1/patients/p1/pairing-code' && r.headers['Idempotency-Key'])).toBe(true);

    await act(async () => void jest.advanceTimersByTime(61_000));
    expect(screen.getByText(/Expires in 8:5\d/)).toBeTruthy();
    await act(async () => void jest.advanceTimersByTime(10 * 60_000));
    expect(await screen.findByText('This code has expired.')).toBeTruthy();
    expect(screen.queryByTestId('qr')).toBeNull();
    expect(screen.getByText('Make a new code')).toBeTruthy();
  });

  it('shows "Connected on …" as soon as a new phone appears (D-016)', async () => {
    let connected = false;
    const { service } = await signedIn((path) => (path.endsWith('/pairing-code') ? json(201, codeAt(10 * 60_000)) : json(200, patient({ devices: connected ? [phone({ label: 'Galaxy A15' })] : [] }))));
    await renderScreen(<PatientScreen />, service, { load: false });
    await fireEvent.press(await screen.findByTestId('make-code'));
    await screen.findByText('ABCD-2345');
    connected = true;
    await act(async () => void jest.advanceTimersByTime(4_100));
    expect(await screen.findByText('Connected on Galaxy A15')).toBeTruthy();
    expect(screen.queryByTestId('qr')).toBeNull(); // the code is spent
  });

  it('does not mistake a phone that was already connected for a new one', async () => {
    const { service } = await signedIn((path) => (path.endsWith('/pairing-code') ? json(201, codeAt(10 * 60_000)) : json(200, patient({ devices: [phone()] }))));
    await renderScreen(<PatientScreen />, service, { load: false });
    await fireEvent.press(await screen.findByTestId('make-code'));
    await screen.findByText('ABCD-2345');
    await act(async () => void jest.advanceTimersByTime(9_000));
    expect(screen.queryByText(/Connected on/)).toBeNull();
    expect(screen.getByText('ABCD-2345')).toBeTruthy();
  });

  it('disconnects a phone after asking, and offers to reconnect with a new code', async () => {
    const spy = jest.spyOn(Alert, 'alert');
    let revoked = false;
    const { service, requests } = await signedIn((path) => {
      if (path.includes('/revoke')) {
        revoked = true;
        return json(200, phone({ revoked_at: 'now' }));
      }
      return json(200, patient({ devices: [phone({ revoked_at: revoked ? 'now' : null })] }));
    });
    await renderScreen(<PatientScreen />, service, { load: false });
    await fireEvent.press(await screen.findByTestId('revoke-d1'));
    expect(requests.some((r) => r.path.includes('/revoke'))).toBe(false); // nothing happens without confirmation
    const buttons = spy.mock.calls[0]![2]!;
    await act(async () => void buttons.find((b) => b.style === 'destructive')!.onPress!());
    await waitFor(() => expect(requests.some((r) => r.path === '/v1/devices/d1/revoke' && r.method === 'POST')).toBe(true));
    expect(await screen.findByText('Disconnected')).toBeTruthy();
    expect(screen.getByText('Reconnect with a new code')).toBeTruthy();
  });

  it('shows a device that needs attention', async () => {
    const { service } = await signedIn(() => json(200, patient({ devices: [phone({ healthy: false, problems: ['permission_off'] })] })));
    await renderScreen(<PatientScreen />, service, { load: false });
    expect(await screen.findByText('Needs attention')).toBeTruthy();
  });

  it('explains a failure to make a code', async () => {
    const { service } = await signedIn((path) => (path.endsWith('/pairing-code') ? apiError(403, 'SUBSCRIPTION_INACTIVE') : json(200, patient())));
    await renderScreen(<PatientScreen />, service, { load: false });
    await fireEvent.press(await screen.findByTestId('make-code'));
    expect(await screen.findByText('An active subscription is needed to add patients.')).toBeTruthy();
  });
});
