import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

// Routes that need no credentials: auth/register, auth/login, auth/refresh, pairing/*, app/config (docs/04-api.md#auth).
// Everything else requires a signed-in caregiver; the guard is deny-by-default.
export const Public = () => SetMetadata(IS_PUBLIC, true);
