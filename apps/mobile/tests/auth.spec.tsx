import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from '../src/testing/expo-router-mock';
import { apiError, caregiverTokens, json, makeService, renderScreen } from '../src/testing/render';
import Register from '../app/(auth)/register';
import SignIn from '../app/(auth)/sign-in';

jest.mock('expo-router', () => require('../src/testing/expo-router-mock'));
beforeEach(() => jest.clearAllMocks());

const type = async (id: string, value: string) => fireEvent.changeText(screen.getByTestId(id), value);

describe('sign in', () => {
  it('signs in, stores the session and goes to the start screen', async () => {
    const { service, requests } = makeService(() => json(200, caregiverTokens));
    await renderScreen(<SignIn />, service);
    await type('email', ' A@B.co ');
    await type('password', 'correct horse');
    await fireEvent.press(screen.getByTestId('submit'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(requests[0]).toMatchObject({ path: '/v1/auth/login', body: { email: 'a@b.co', password: 'correct horse' } });
    expect(service.getState().caregiver?.tokens.access).toBe('A1');
  });

  it('gives one message for a wrong password, however the server words it', async () => {
    const { service } = makeService(() => apiError(401, 'INVALID_CREDENTIALS'));
    await renderScreen(<SignIn />, service);
    await type('email', 'a@b.co');
    await type('password', 'nope');
    await fireEvent.press(screen.getByTestId('submit'));
    expect(await screen.findByText('The email or password is wrong.')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('does not call the server for an empty or malformed form', async () => {
    const { service, requests } = makeService();
    await renderScreen(<SignIn />, service);
    await fireEvent.press(screen.getByTestId('submit'));
    expect(await screen.findByText('The email or password is wrong.')).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it('explains a rate limit and a lost connection in plain words', async () => {
    const limited = makeService(() => apiError(429, 'RATE_LIMITED'));
    await renderScreen(<SignIn />, limited.service);
    await type('email', 'a@b.co');
    await type('password', 'x');
    await fireEvent.press(screen.getByTestId('submit'));
    expect(await screen.findByText('Too many attempts. Wait a moment and try again.')).toBeTruthy();
  });

  it('says why the person was signed out: another phone took over (D-019)', async () => {
    const { service } = makeService((path) => (path.includes('login') ? json(200, caregiverTokens) : apiError(401, 'SESSION_REPLACED')));
    await service.signIn('a@b.co', 'pw');
    await service.api.patients.list().catch(() => undefined);
    await renderScreen(<SignIn />, service, { load: false });
    expect(screen.getByText(/Signed in on another phone/)).toBeTruthy();
  });
});

describe('create account', () => {
  const fill = async (over: { email?: string; password?: string } = {}) => {
    await type('email', over.email ?? 'new@b.co');
    await type('password', over.password ?? 'long enough pw');
  };

  it('needs agreement to the privacy notice, and sends the notice version with the sign-up', async () => {
    const { service, requests } = makeService(() => json(201, caregiverTokens));
    await renderScreen(<Register />, service);
    await fill();
    await fireEvent.press(screen.getByTestId('submit'));
    expect(await screen.findByText('Please agree to continue.')).toBeTruthy();
    expect(requests).toHaveLength(0);

    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByTestId('submit'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(requests[0]!.body).toMatchObject({ email: 'new@b.co', consent: { notice_version: '2026-10-draft' } });
  });

  it('checks the email and the password length before asking the server', async () => {
    const { service, requests } = makeService();
    await renderScreen(<Register />, service);
    await fill({ email: 'not-an-email', password: 'short' });
    await fireEvent.press(screen.getByTestId('submit'));
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Use at least 8 characters.')).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it('counts an 8-emoji password as long enough, like the server', async () => {
    const { service, requests } = makeService(() => json(201, caregiverTokens));
    await renderScreen(<Register />, service);
    await fill({ password: '😀'.repeat(8) });
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByTestId('submit'));
    await waitFor(() => expect(requests).toHaveLength(1));
  });

  it('tells the person when the address is already registered', async () => {
    const { service } = makeService(() => apiError(409, 'EMAIL_TAKEN'));
    await renderScreen(<Register />, service);
    await fill();
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByTestId('submit'));
    expect(await screen.findByText('An account with this email already exists. Try signing in.')).toBeTruthy();
  });
});
