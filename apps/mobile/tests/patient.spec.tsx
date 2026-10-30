import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from '../src/testing/expo-router-mock';
import { apiError, caregiverTokens, json, makeService, renderScreen } from '../src/testing/render';
import Entry from '../app/index';
import Pair from '../app/(pairing)/pair';
import PatientLayout from '../app/(patient)/_layout';
import Rejected from '../app/(patient)/rejected';
import Today from '../app/(patient)/today';

jest.mock('expo-router', () => require('../src/testing/expo-router-mock'));
// The camera: tests trigger a scan by calling the handler the screen registered.
const mockCamera: { onScan?: (e: { data: string }) => void; granted: boolean; request: jest.Mock } = { granted: true, request: jest.fn() };
jest.mock('expo-camera', () => {
  const { View } = require('react-native');
  return {
    CameraView: (props: { onBarcodeScanned?: (e: { data: string }) => void }) => {
      mockCamera.onScan = props.onBarcodeScanned;
      return <View testID="camera" />;
    },
    useCameraPermissions: () => [{ granted: mockCamera.granted }, mockCamera.request],
  };
});
beforeEach(() => {
  jest.clearAllMocks();
  mockCamera.granted = true;
  mockCamera.onScan = undefined;
});

const redeemed = { device_id: 'd1', device_token: 'DT', patient: { id: 'p1', display_name: 'Asha', timezone: 'Asia/Kolkata' } };
const dose = (over: object = {}) => ({ id: 'dose1', medicine_id: 'm1', scheduled_at: '2026-11-01T02:30:00Z', local_time: '08:00', name: 'Metformin', amount: '1 tablet', status: 'pending', snooze_until: null, alert_due_at: '2026-11-01T03:00:00Z', notification_type: 'standard', ...over });
const sync = (over: object = {}) => ({ cursor: 'c', patient: { id: 'p1', display_name: 'Asha', timezone: 'Asia/Kolkata', status: 'active', lockscreen_detail: 'full' }, account_state: 'active', medicines: [], doses: [dose()], window: { from: '', through: '' }, commands: [], ...over });

async function paired(handler: Parameters<typeof makeService>[0]) {
  const made = makeService((path, init) => (path.includes('/pairing/redeem') ? json(201, redeemed) : handler!(path, init)));
  await made.service.load();
  await made.service.pair('ABCD2345', 'n');
  return made;
}

describe('connecting a phone', () => {
  it('asks for the patient’s own consent before anything else', async () => {
    const { service, requests } = makeService();
    await renderScreen(<Pair />, service);
    expect(screen.getByText('Before we connect')).toBeTruthy();
    expect(screen.queryByTestId('choose-type')).toBeNull();
    await fireEvent.press(screen.getByTestId('agree'));
    expect(screen.getByTestId('choose-type')).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it('connects with a typed code, sending the consent version, and moves on', async () => {
    const { service, requests } = makeService(() => json(201, redeemed));
    await renderScreen(<Pair />, service);
    await fireEvent.press(screen.getByTestId('agree'));
    await fireEvent.press(screen.getByTestId('choose-type'));
    expect(screen.getByTestId('submit').props.accessibilityState.disabled).toBe(true); // nothing typed yet
    await fireEvent.changeText(screen.getByTestId('code'), 'abcd-2345');
    await fireEvent.press(screen.getByTestId('submit'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(requests[0]!.body).toMatchObject({ code: 'ABCD2345', consent: { notice_version: '2026-10-draft' } });
    expect(service.getState().patient?.patientId).toBe('p1');
  });

  it.each([
    ['CODE_INVALID', 422, 'That code is not right. Check it and try again.'],
    ['CODE_EXPIRED_OR_USED', 410, 'That code has expired or was already used. Ask your caregiver for a new one.'],
    ['DEVICE_LIMIT_REACHED', 409, 'This person already has the most phones allowed. Ask your caregiver to disconnect one.'],
    ['PATIENT_SUSPENDED', 403, 'Reminders are paused for this person right now.'],
    ['RATE_LIMITED', 429, 'Too many attempts. Wait a moment and try again.'],
  ])('explains %s in plain words', async (code, status, text) => {
    const { service } = makeService(() => apiError(status, code));
    await renderScreen(<Pair />, service);
    await fireEvent.press(screen.getByTestId('agree'));
    await fireEvent.press(screen.getByTestId('choose-type'));
    await fireEvent.changeText(screen.getByTestId('code'), 'ABCD2345');
    await fireEvent.press(screen.getByTestId('submit'));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('says so when the code is typed wrongly, without calling the server', async () => {
    const { service, requests } = makeService();
    await renderScreen(<Pair />, service);
    await fireEvent.press(screen.getByTestId('agree'));
    await fireEvent.press(screen.getByTestId('choose-type'));
    await fireEvent.changeText(screen.getByTestId('code'), 'ABCD-23O5');
    await fireEvent.press(screen.getByTestId('submit'));
    expect(await screen.findByText('That code is not right. Check it and try again.')).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it('scans a QR code once, however many times the camera reports it', async () => {
    const { service, requests } = makeService(() => json(201, redeemed));
    await renderScreen(<Pair />, service);
    await fireEvent.press(screen.getByTestId('agree'));
    await fireEvent.press(screen.getByTestId('choose-scan'));
    expect(screen.getByTestId('camera')).toBeTruthy();
    await act(async () => {
      mockCamera.onScan!({ data: 'medremind://pair?c=ABCD2345' });
      mockCamera.onScan!({ data: 'medremind://pair?c=ABCD2345' });
      mockCamera.onScan!({ data: 'medremind://pair?c=ABCD2345' });
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(requests.filter((r) => r.path === '/v1/pairing/redeem')).toHaveLength(1);
  });

  it('ignores a QR code that is not ours, and a transfer code', async () => {
    const { service, requests } = makeService(() => json(201, redeemed));
    await renderScreen(<Pair />, service);
    await fireEvent.press(screen.getByTestId('agree'));
    await fireEvent.press(screen.getByTestId('choose-scan'));
    await act(async () => void mockCamera.onScan!({ data: 'https://example.com/pay' }));
    expect(await screen.findByText('That is not a Medicine Reminder code.')).toBeTruthy();
    await act(async () => void mockCamera.onScan!({ data: 'medremind://transfer?c=ABCD2345' }));
    expect(requests).toHaveLength(0);
  });

  it('works without the camera: asks once, and offers typing', async () => {
    mockCamera.granted = false;
    const { service } = makeService();
    await renderScreen(<Pair />, service);
    await fireEvent.press(screen.getByTestId('agree'));
    await fireEvent.press(screen.getByTestId('choose-scan'));
    expect(screen.getByText('The camera is off. Type the code instead.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('allow-camera'));
    expect(mockCamera.request).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('to-type'));
    expect(screen.getByTestId('code')).toBeTruthy();
  });
});

describe('Today', () => {
  it('lists the doses in the patient’s own time with their state', async () => {
    const { service } = await paired(() => json(200, sync({ doses: [dose(), dose({ id: 'd2', name: 'Vitamin D', amount: '2 drops', status: 'taken', scheduled_at: '2026-11-01T15:30:00Z' })] })));
    await renderScreen(<Today />, service, { load: false });
    expect(await screen.findByText('Metformin')).toBeTruthy();
    expect(screen.getByText('1 tablet')).toBeTruthy();
    expect(screen.getByText('at 08:00 · Waiting')).toBeTruthy(); // 02:30 UTC is 08:00 in Kolkata
    expect(screen.getByText('at 21:00 · Taken')).toBeTruthy();
  });

  it('works with nothing scheduled, and shows the paused and grace banners', async () => {
    const empty = await paired(() => json(200, sync({ doses: [] })));
    await renderScreen(<Today />, empty.service, { load: false });
    expect(await screen.findByText('No medicines scheduled.')).toBeTruthy();
  });

  it('tells a patient whose caregiver’s plan lapsed (07)', async () => {
    const paused = await paired(() => json(200, sync({ account_state: 'suspended', doses: [] })));
    await renderScreen(<Today />, paused.service, { load: false });
    expect(await screen.findByText('Reminders are paused. Ask your caregiver.')).toBeTruthy();
    expect(screen.queryByText('No medicines scheduled.')).toBeNull();
  });

  it('warns during the 1-day grace', async () => {
    const grace = await paired(() => json(200, sync({ account_state: 'grace' })));
    await renderScreen(<Today />, grace.service, { load: false });
    expect(await screen.findByText('Reminders stop tomorrow. Ask your caregiver.')).toBeTruthy();
  });

  it('uses the device token, and keeps the reminders when the connection fails', async () => {
    const { service, requests } = await paired(() => apiError(500, 'INTERNAL'));
    await renderScreen(<Today />, service, { load: false });
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeTruthy();
    expect(requests.at(-1)!.headers.Authorization).toBe('Device DT');
    expect(service.getState().patient).not.toBeNull(); // still paired
  });

  it('a revoked phone goes to the "ask for a new code" screen and stays paired (D-015)', async () => {
    const { service } = await paired(() => apiError(401, 'DEVICE_TOKEN_REJECTED'));
    await renderScreen(<Today />, service, { load: false });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/rejected'));
    expect(service.getState()).toMatchObject({ deviceRejected: true, patient: { deviceToken: 'DT' } });
  });
});

describe('revoked phone', () => {
  it('shows one screen with one way forward', async () => {
    const { service } = makeService();
    await renderScreen(<Rejected />, service);
    expect(screen.getByText('Ask your caregiver for a new code')).toBeTruthy();
    expect(screen.getByText(/Reminders already on this phone still ring/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('enter-code'));
    expect(router.replace).toHaveBeenCalledWith('/pair');
  });

  it('pairing again clears it', async () => {
    const { service } = await paired(() => json(200, sync()));
    await service.markRejected();
    expect(service.getState().deviceRejected).toBe(true);
    await service.pair('ABCD2345', 'n');
    expect(service.getState().deviceRejected).toBe(false);
  });
});

describe('where the app opens', () => {
  const where = async (setup: (s: ReturnType<typeof makeService>) => Promise<void> | void, load = true) => {
    const made = makeService(() => json(200, caregiverTokens));
    await setup(made);
    await renderScreen(<Entry />, made.service, { load });
    return screen.queryByTestId('redirect')?.props.children;
  };

  it('waits for storage, then asks for a mode', async () => {
    const { service, plain } = makeService();
    plain.get = () => new Promise(() => undefined); // storage that never answers
    await renderScreen(<Entry />, service, { load: false });
    expect(screen.queryByTestId('redirect')).toBeNull(); // nothing is decided while loading
    expect(await where(() => undefined)).toBe('/mode');
  });
  it('caregiver: sign in, or the patient list', async () => {
    expect(await where(({ plain }) => void plain.data.set('med.mode', 'caregiver'))).toBe('/sign-in');
    expect(
      await where(({ plain, secure }) => {
        plain.data.set('med.mode', 'caregiver');
        secure.data.set('med.email', 'a@b.co');
        secure.data.set('med.access', 'A');
        secure.data.set('med.refresh', 'R');
      }),
    ).toBe('/patients');
  });
  it('patient: pair, then Today, or the revoked screen', async () => {
    expect(await where(({ plain }) => void plain.data.set('med.mode', 'patient'))).toBe('/pair');
    const patient = JSON.stringify({ deviceToken: 'T', patientId: 'p1', displayName: 'A', timezone: 'UTC' });
    expect(
      await where(({ plain, secure }) => {
        plain.data.set('med.mode', 'patient');
        secure.data.set('med.patient', patient);
      }),
    ).toBe('/today');
    expect(
      await where(({ plain, secure }) => {
        plain.data.set('med.mode', 'patient');
        plain.data.set('med.device_rejected', '1');
        secure.data.set('med.patient', patient);
      }),
    ).toBe('/rejected');
  });
  it('the forced-update screen takes over without touching the pairing (D-080)', async () => {
    const { service } = await paired((path) => (path.includes('/device/sync') ? apiError(426, 'UPGRADE_REQUIRED', { min_app_version: '2.0.0' }) : json(200, {})));
    await service.setMode('patient');
    await service.api.device.sync().catch(() => undefined);
    await renderScreen(<Entry />, service, { load: false });
    expect(screen.getByTestId('redirect').props.children).toBe('/upgrade');
    expect(service.getState().patient).not.toBeNull();
  });
  it('an unpaired phone cannot open the patient screens', async () => {
    const { service } = makeService();
    await renderScreen(<PatientLayout />, service);
    expect(screen.getByTestId('redirect').props.children).toBe('/pair');
  });
});
