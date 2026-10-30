import { SetMetadata } from '@nestjs/common';

export const AUTH_SCHEME = 'authScheme';
export type AuthScheme = 'caregiver' | 'device' | 'either';

// Which credential a route takes: caregiver JWT (default), paired-device token, or either (docs/04-api.md#auth).
export const DeviceAuth = () => SetMetadata(AUTH_SCHEME, 'device' satisfies AuthScheme);
export const AnyAuth = () => SetMetadata(AUTH_SCHEME, 'either' satisfies AuthScheme);
