import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { ObjectStorage } from './object-storage.js';

export const MAX_PHOTO_BYTES = 1024 * 1024; // D-091
export const UPLOAD_URL_SECONDS = 5 * 60;
export const READ_URL_SECONDS = 15 * 60; // docs/10-security-privacy.md#photos (suggested)
const SCAN_BYTES = 64 * 1024;

// A JPEG carries EXIF in an APP1 segment (0xFF 0xE1) whose payload starts with "Exif\0\0".
export function hasExif(jpegStart: Buffer): boolean {
  let i = 2; // after SOI
  while (i + 4 < jpegStart.length && jpegStart[i] === 0xff) {
    const marker = jpegStart[i + 1]!;
    if (marker === 0xda) return false; // start of scan: no more metadata segments
    const length = jpegStart.readUInt16BE(i + 2);
    if (marker === 0xe1 && jpegStart.subarray(i + 4, i + 10).toString('latin1') === 'Exif\0\0') return true;
    i += 2 + length;
  }
  return false;
}

export const photoKeyFor = (patientId: string) => `p/${patientId}/m/${randomUUID()}.jpg`;
export const photoEtag = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16); // a new upload is a new key

@Injectable()
export class PhotosService {
  private readonly log = new Logger(PhotosService.name);

  constructor(@Inject(ObjectStorage) private readonly storage: ObjectStorage) {}

  async presignUpload(patientId: string, byteSize: number) {
    const key = photoKeyFor(patientId);
    const url = await this.storage.presignPut(key, 'image/jpeg', UPLOAD_URL_SECONDS);
    return { object_key: key, upload_url: url, headers: { 'Content-Type': 'image/jpeg' }, expires_at: new Date(Date.now() + UPLOAD_URL_SECONDS * 1000), max_bytes: MAX_PHOTO_BYTES, declared_bytes: byteSize };
  }

  // When a key is attached to a medicine: R2 can't enforce size on a presigned PUT (R-19), so check it here and
  // delete anything oversize, of the wrong type, or still carrying EXIF (D-091).
  async verifyUploaded(key: string): Promise<void> {
    const head = await this.storage.head(key);
    if (!head) throw ApiException.validation({ photo_object_key: 'has not been uploaded' });
    const bad =
      head.size > MAX_PHOTO_BYTES ? 'is larger than 1 MB' : head.size < 4 || head.contentType !== 'image/jpeg' ? 'must be a JPEG' : hasExif(await this.storage.readStart(key, SCAN_BYTES)) ? 'must not contain EXIF data' : null;
    if (bad) {
      await this.storage.delete(key).catch(() => this.log.warn('could not delete a rejected upload'));
      throw ApiException.validation({ photo_object_key: bad });
    }
  }

  async readUrl(key: string | null): Promise<{ url: string; expires_at: Date; etag: string } | null> {
    if (!key) return null;
    return { url: await this.storage.presignGet(key, READ_URL_SECONDS), expires_at: new Date(Date.now() + READ_URL_SECONDS * 1000), etag: photoEtag(key) };
  }

  // Exports are private, short-lived files (docs/10-security-privacy.md); set an R2 lifecycle rule to expire `exports/`.
  async putExport(key: string, body: Buffer): Promise<void> {
    await this.storage.putObject(key, body, 'application/json');
  }

  async exists(key: string): Promise<boolean> {
    return (await this.storage.head(key)) !== null;
  }

  signedGet(key: string, seconds = READ_URL_SECONDS): Promise<string> {
    return this.storage.presignGet(key, seconds);
  }

  deleteQuietly(key: string | null): void {
    if (key) void this.storage.delete(key).catch(() => this.log.warn('could not delete an orphaned photo'));
  }
}
