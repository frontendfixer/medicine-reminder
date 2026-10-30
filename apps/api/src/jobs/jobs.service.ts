import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { OutboxSender } from '../push/outbox-sender.js';
import { SubscriptionSyncService } from '../billing/revenuecat/subscription-sync.service.js';
import { DoseGeneratorService } from './dose-generator.service.js';
import { HealthService } from './health.service.js';
import { SweeperService } from './sweeper.service.js';

export const QUEUE_NAME = 'med-jobs';

// Job Schedulers (D-071): upserted idempotently on every worker boot, so a restart or a second worker never
// duplicates them. They only trigger work; every job reads its state from Postgres, so losing Redis loses no reminder.
export const SCHEDULERS = [
  { id: 'sweeper', repeat: { every: 60_000 } },
  { id: 'outbox', repeat: { every: 10_000 } },
  { id: 'push-receipts', repeat: { every: 15 * 60_000 } },
  { id: 'device-health', repeat: { every: 15 * 60_000 } },
  { id: 'dose-generator', repeat: { pattern: '0 0 2 * * *', tz: 'UTC' } },
  { id: 'rc-events', repeat: { every: 10_000 } },
  { id: 'rc-reconcile', repeat: { pattern: '0 0 4 * * *', tz: 'UTC' } },
] as const;

@Injectable()
export class JobsService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(JobsService.name);
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];

  constructor(
    private readonly sweeper: SweeperService,
    private readonly sender: OutboxSender,
    private readonly health: HealthService,
    private readonly generator: DoseGeneratorService,
    private readonly subscriptions: SubscriptionSyncService,
  ) {}

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL is required');
    const connect = () => {
      const c = new Redis(url, { maxRetriesPerRequest: null }); // required by BullMQ workers
      c.on('error', (e: Error) => this.log.error(`Redis error: ${e.name}`));
      this.connections.push(c);
      return c;
    };
    this.queue = new Queue(QUEUE_NAME, { connection: connect() });
    for (const s of SCHEDULERS) await this.queue.upsertJobScheduler(s.id, { ...s.repeat }, { name: s.id, opts: { removeOnComplete: 20, removeOnFail: 100 } });
    this.worker = new Worker(QUEUE_NAME, (job) => this.handle(job), { connection: connect(), concurrency: 4 });
    this.worker.on('failed', (job, err) => this.log.error(`Job ${job?.name ?? '?'} failed: ${err.name}`)); // class only: messages can carry data
  }

  async handle(job: Pick<Job, 'name'>): Promise<unknown> {
    switch (job.name) {
      case 'sweeper': {
        const result = await this.sweeper.run();
        await this.sender.sendQueued(); // push what the passes just queued, without waiting for the next outbox tick
        return result;
      }
      case 'outbox':
        return this.sender.sendQueued(8_000);
      case 'push-receipts':
        return this.sender.processReceipts();
      case 'device-health':
        return this.health.alertUnhealthy();
      case 'dose-generator':
        return this.generator.generateAll();
      case 'rc-events':
        return this.subscriptions.processPending();
      case 'rc-reconcile':
        return this.subscriptions.reconcile();
      default:
        this.log.warn(`Unknown job ${job.name}`);
        return null;
    }
  }

  getQueue(): Queue | undefined {
    return this.queue;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }
}
