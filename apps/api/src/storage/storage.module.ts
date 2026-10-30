import { Global, Module } from '@nestjs/common';
import { MemoryObjectStorage } from './memory-object-storage.js';
import { ObjectStorage } from './object-storage.js';
import { PhotosService } from './photos.service.js';
import { S3ObjectStorage } from './s3-object-storage.js';

@Global()
@Module({
  providers: [
    {
      provide: ObjectStorage,
      useFactory: (): ObjectStorage => {
        const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: key, R2_SECRET_ACCESS_KEY: secret, R2_BUCKET: bucket } = process.env;
        if (account && key && secret && bucket) return new S3ObjectStorage(bucket, account, key, secret);
        if (process.env.NODE_ENV === 'production') throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are required in production');
        return new MemoryObjectStorage(); // dev and tests
      },
    },
    PhotosService,
  ],
  exports: [ObjectStorage, PhotosService],
})
export class StorageModule {}
