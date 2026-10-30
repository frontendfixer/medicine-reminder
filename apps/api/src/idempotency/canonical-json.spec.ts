import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it('ignores key order at every depth but keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('tells different bodies apart, and treats no body as empty', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
    expect(canonicalJson(undefined)).toBe('');
  });
});
