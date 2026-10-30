import { compareVersions, parseVersion } from './version.js';

describe('versions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
  });
  it('ignores pre-release suffixes and tolerates junk', () => {
    expect(parseVersion('1.2.3-beta.1')).toEqual([1, 2, 3]);
    expect(parseVersion('nope')).toBeNull();
    expect(compareVersions('nope', '1.0.0')).toBe(0);
  });
});
