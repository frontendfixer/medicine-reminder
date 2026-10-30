import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule);
app.enableShutdownHooks();
