import { Global, Module } from '@nestjs/common';
import { NotificationComposer } from './composer.js';
import { ExpoPushTransport } from './expo-push-transport.js';
import { FakePushTransport } from './fake-push-transport.js';
import { OutboxSender } from './outbox-sender.js';
import { PushTransport } from './push-transport.js';

@Global()
@Module({
  providers: [
    {
      provide: PushTransport,
      useFactory: (): PushTransport => {
        const token = process.env.EXPO_ACCESS_TOKEN;
        if (process.env.NODE_ENV === 'production') {
          if (!token) throw new Error('EXPO_ACCESS_TOKEN is required in production (enhanced push security, D-090)');
          return new ExpoPushTransport(token);
        }
        return token ? new ExpoPushTransport(token) : new FakePushTransport(); // dev and tests: nothing is sent
      },
    },
    NotificationComposer,
    OutboxSender,
  ],
  exports: [PushTransport, OutboxSender, NotificationComposer],
})
export class PushModule {}
