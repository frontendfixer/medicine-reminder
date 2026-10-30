import { Global, Module } from '@nestjs/common';
import { FieldEncryption } from './field-encryption.js';
import { Hmac } from './hmac.js';

@Global()
@Module({
  providers: [
    { provide: FieldEncryption, useFactory: () => FieldEncryption.fromEnv() },
    { provide: Hmac, useFactory: () => Hmac.fromEnv() },
  ],
  exports: [FieldEncryption, Hmac],
})
export class CryptoModule {}
