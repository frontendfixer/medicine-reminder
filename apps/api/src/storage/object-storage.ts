// What the API needs from object storage. Production is Cloudflare R2 over the S3 API; dev and tests use memory.
export interface ObjectHead {
  size: number;
  contentType: string | undefined;
}

export abstract class ObjectStorage {
  // A URL the phone can PUT the file to. The Content-Type is part of the signature.
  abstract presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  abstract presignGet(key: string, expiresInSeconds: number): Promise<string>;
  abstract head(key: string): Promise<ObjectHead | null>;
  // The first `bytes` of the object, to look for EXIF markers.
  abstract readStart(key: string, bytes: number): Promise<Buffer>;
  abstract delete(key: string): Promise<void>;
  // Server-side upload, for data exports.
  abstract putObject(key: string, body: Buffer, contentType: string): Promise<void>;
}
