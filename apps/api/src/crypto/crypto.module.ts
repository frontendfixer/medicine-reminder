import { Global, Module } from '@nestjs/common';
import { FieldEncryption } from './field-encryption.js';

@Global()
@Module({
  providers: [{ provide: FieldEncryption, useFactory: () => FieldEncryption.fromEnv() }],
  exports: [FieldEncryption],
})
export class CryptoModule {}
