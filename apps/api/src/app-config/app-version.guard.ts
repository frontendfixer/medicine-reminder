import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import type { AuthedRequest } from '../common/principal.js';
import { AppConfigService } from './app-config.service.js';
import { compareVersions, parseVersion } from './version.js';

// Answers and heartbeats from old builds are always accepted, and so is the config that tells them to update (D-080).
const ALWAYS_ALLOWED = new Set(['/v1/app/config', '/v1/devices/heartbeat', '/v1/device/dose-responses']);

@Injectable()
export class AppVersionGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const version = req.header('x-app-version');
    const platform = req.header('x-platform');
    if (!version || !parseVersion(version) || (platform !== 'ios' && platform !== 'android')) return true; // not our app
    if (ALWAYS_ALLOWED.has((req.originalUrl ?? req.url).split('?')[0]!)) return true;
    const min = this.config.minVersion(platform);
    if (compareVersions(version, min) < 0) {
      throw new ApiException('UPGRADE_REQUIRED', 'Please update the app to continue.', { min_app_version: min });
    }
    return true;
  }
}
