import { checkManifest } from '../scripts/check-manifest';

const manifest = (...lines: string[]) => `<manifest xmlns:tools="x">${lines.map((l) => `<uses-permission ${l}/>`).join('')}</manifest>`;
const exact = 'android:name="android.permission.SCHEDULE_EXACT_ALARM"';

describe('Android manifest check (D-073, D-074)', () => {
  it('accepts the intended permissions, with the blocked ones removed', () => {
    const xml = manifest(exact, 'android:name="android.permission.CAMERA"', 'android:name="android.permission.USE_EXACT_ALARM" tools:node="remove"', 'android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" tools:node="remove"');
    expect(checkManifest(xml)).toEqual([]);
  });
  it('fails if USE_EXACT_ALARM is declared', () => {
    expect(checkManifest(manifest(exact, 'android:name="android.permission.USE_EXACT_ALARM"'))).toEqual(['USE_EXACT_ALARM must not be declared']);
  });
  it('fails if the direct battery-exemption request or the microphone sneaks in', () => {
    const problems = checkManifest(manifest(exact, 'android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"', 'android:name="android.permission.RECORD_AUDIO"'));
    expect(problems).toEqual(['REQUEST_IGNORE_BATTERY_OPTIMIZATIONS must not be declared', 'RECORD_AUDIO must not be declared']);
  });
  it('fails if exact alarms are not declared, or only removed', () => {
    expect(checkManifest(manifest('android:name="android.permission.CAMERA"'))).toEqual(['SCHEDULE_EXACT_ALARM must be declared (D-073)']);
    expect(checkManifest(manifest(`${exact} tools:node="remove"`))).toEqual(['SCHEDULE_EXACT_ALARM must be declared (D-073)']);
  });
});
