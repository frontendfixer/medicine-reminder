import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type ObjectHead, ObjectStorage } from './object-storage.js';

// Cloudflare R2 through its S3 API (R-19). Presigned URLs work on this endpoint only, not on a custom domain.
export class S3ObjectStorage extends ObjectStorage {
  private readonly s3: S3Client;

  constructor(
    private readonly bucket: string,
    accountId: string,
    accessKeyId: string,
    secretAccessKey: string,
  ) {
    super();
    this.s3 = new S3Client({ region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } });
  }

  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn: expiresInSeconds });
  }

  presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSeconds });
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: out.ContentLength ?? 0, contentType: out.ContentType };
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async readStart(key: string, bytes: number): Promise<Buffer> {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
