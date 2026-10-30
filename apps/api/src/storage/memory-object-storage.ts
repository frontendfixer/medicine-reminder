import { type ObjectHead, ObjectStorage } from './object-storage.js';

// For local development and tests. URLs look real but point nowhere; tests put objects in directly.
export class MemoryObjectStorage extends ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  put(key: string, body: Buffer, contentType = 'image/jpeg'): void {
    this.objects.set(key, { body, contentType });
  }
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return Promise.resolve(`http://storage.invalid/${key}?method=PUT&type=${encodeURIComponent(contentType)}&expires=${expiresInSeconds}`);
  }
  presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return Promise.resolve(`http://storage.invalid/${key}?method=GET&expires=${expiresInSeconds}`);
  }
  head(key: string): Promise<ObjectHead | null> {
    const o = this.objects.get(key);
    return Promise.resolve(o ? { size: o.body.length, contentType: o.contentType } : null);
  }
  readStart(key: string, bytes: number): Promise<Buffer> {
    return Promise.resolve(this.objects.get(key)?.body.subarray(0, bytes) ?? Buffer.alloc(0));
  }
  putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    this.put(key, body, contentType);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}
