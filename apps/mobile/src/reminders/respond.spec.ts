import { forgetRecent, parseResponse, seenRecently } from './respond';

const response = (actionIdentifier: string, over: { id?: string; dose?: unknown; date?: number } = {}) =>
  ({ actionIdentifier, notification: { date: over.date ?? 1, request: { identifier: over.id ?? 'dose:abc', content: { data: over.dose === undefined ? { dose_id: 'abc' } : over.dose } } } }) as never;

describe('parseResponse', () => {
  it.each([
    ['TAKEN', 'taken'],
    ['NOT_TAKEN', 'not_taken'],
    ['SNOOZE_10', 'snooze'],
  ])('the %s button answers the dose', (button, action) => {
    expect(parseResponse(response(button))).toEqual({ kind: 'answer', doseId: 'abc', action });
  });

  it('a plain tap opens the app, for that dose', () => {
    expect(parseResponse(response('expo.modules.notifications.actions.DEFAULT'))).toEqual({ kind: 'open', doseId: 'abc' });
  });

  it('finds the dose from the notification ID when the data is missing, including follow-ups and snoozes', () => {
    expect(parseResponse(response('TAKEN', { dose: {}, id: 'dose:xyz:f3' }))).toEqual({ kind: 'answer', doseId: 'xyz', action: 'taken' });
    expect(parseResponse(response('SNOOZE_10', { dose: undefined, id: 'dose:q:sf1' }))).toMatchObject({ doseId: 'abc' }); // data wins when present
  });

  it('ignores a button it does not know, or a notification that is not about a dose', () => {
    expect(parseResponse(response('SOMETHING_ELSE'))).toEqual({ kind: 'ignore' });
    expect(parseResponse(response('TAKEN', { dose: {}, id: 'unrelated' }))).toEqual({ kind: 'ignore' });
  });
});

describe('seenRecently', () => {
  beforeEach(forgetRecent);
  it('catches the same tap arriving twice, but not a later tap or another button', () => {
    expect(seenRecently(response('TAKEN'), 1000)).toBe(false);
    expect(seenRecently(response('TAKEN'), 2000)).toBe(true);
    expect(seenRecently(response('NOT_TAKEN'), 2000)).toBe(false);
    expect(seenRecently(response('TAKEN', { date: 99 }), 2000)).toBe(false);
  });
  it('forgets after a minute', () => {
    seenRecently(response('TAKEN'), 1000);
    expect(seenRecently(response('TAKEN'), 1000 + 61_000)).toBe(false);
  });
});
