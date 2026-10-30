import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/parse.js';
import type { AuthedRequest } from '../common/principal.js';
import { PatientsRepository, assertPatientWritable } from '../patients/patients.repository.js';
import { MAX_PHOTO_BYTES, PhotosService } from '../storage/photos.service.js';

const presignBody = z.object({
  patient_id: z.string({ error: 'is required' }),
  content_type: z.literal('image/jpeg', { error: 'must be image/jpeg' }),
  byte_size: z.number({ error: 'is required' }).int().min(1).max(MAX_PHOTO_BYTES, { error: 'must be at most 1 MB' }),
});

@Controller('v1/uploads')
export class UploadsController {
  constructor(
    private readonly photos: PhotosService,
    private readonly patients: PatientsRepository,
  ) {}

  // docs/04-api.md#uploads. The caller must own an active patient; the key is namespaced to that patient.
  @Post('presign')
  @HttpCode(200)
  async presign(@Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(presignBody, body);
    const patient = await this.patients.findOwned(req.principal!.id, input.patient_id);
    assertPatientWritable(patient);
    const { max_bytes: _m, declared_bytes: _d, ...out } = await this.photos.presignUpload(patient.id, input.byte_size);
    return out;
  }
}
