import { Injectable } from '@nestjs/common';

// docs/04-api.md#app-config, D-080. This contract never breaks: old builds read it to learn they must update.
@Injectable()
export class AppConfigService {
  minVersion(platform: 'ios' | 'android'): string {
    return (platform === 'ios' ? process.env.APP_MIN_VERSION_IOS : process.env.APP_MIN_VERSION_ANDROID) ?? '0.0.0';
  }

  get() {
    return {
      min_app_version: { ios: this.minVersion('ios'), android: this.minVersion('android') },
      latest_app_version: process.env.APP_LATEST_VERSION ?? '0.0.0',
      feature_flags: { stock_tracking: false }, // v1.1 (D-070)
      support_url: process.env.SUPPORT_URL ?? null,
      grievance_contact: process.env.GRIEVANCE_CONTACT ?? null, // OI-19: needs a named person before launch
    };
  }
}
