import { Module } from '@nestjs/common';
import { DosesService } from './doses.service.js';

@Module({ providers: [DosesService], exports: [DosesService] })
export class DosesModule {}
