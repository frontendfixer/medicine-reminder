import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

// Smoke test: the real application boots with every module and answers its public endpoint in the documented shape.
describe('AppModule (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/v1/app/config (GET) is public', () => {
    return request(app.getHttpServer())
      .get('/v1/app/config')
      .expect(200)
      .expect((res) => expect(Object.keys(res.body).sort()).toEqual(['feature_flags', 'grievance_contact', 'latest_app_version', 'min_app_version', 'support_url']));
  });

  it('answers an unknown route in the documented error format', () => {
    return request(app.getHttpServer()).get('/v1/nope').expect(404).expect({ error: { code: 'NOT_FOUND', message: 'Not found.', details: {} } });
  });

  afterEach(async () => {
    await app.close();
  });
});
