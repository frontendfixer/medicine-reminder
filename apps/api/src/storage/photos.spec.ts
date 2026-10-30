import { hasExif, photoEtag } from './photos.service.js';

const segment = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
const SOI = Buffer.from([0xff, 0xd8]);
const jfif = segment(0xe0, Buffer.concat([Buffer.from('JFIF\0'), Buffer.alloc(9)]));
const exif = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.alloc(20)]));
const xmp = segment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.alloc(5)]));
const scan = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.alloc(30)]);

describe('hasExif', () => {
  it('finds an EXIF segment, wherever it sits before the image data', () => {
    expect(hasExif(Buffer.concat([SOI, exif, scan]))).toBe(true);
    expect(hasExif(Buffer.concat([SOI, jfif, exif, scan]))).toBe(true);
  });
  it('ignores other metadata and stops at the scan', () => {
    expect(hasExif(Buffer.concat([SOI, jfif, scan]))).toBe(false);
    expect(hasExif(Buffer.concat([SOI, jfif, xmp, scan]))).toBe(false);
    expect(hasExif(Buffer.concat([SOI, scan, exif]))).toBe(false);
  });
  it('is safe on junk and truncated data', () => {
    for (const b of [Buffer.alloc(0), Buffer.from('not a jpeg'), SOI, Buffer.concat([SOI, exif.subarray(0, 6)]), Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])]) expect(() => hasExif(b)).not.toThrow();
  });
  it('gives each upload its own ETag', () => {
    expect(photoEtag('p/a/m/1.jpg')).not.toBe(photoEtag('p/a/m/2.jpg'));
    expect(photoEtag('p/a/m/1.jpg')).toBe(photoEtag('p/a/m/1.jpg'));
  });
});
