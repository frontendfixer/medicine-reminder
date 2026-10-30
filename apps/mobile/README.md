# Medicine Reminder — mobile app

Expo SDK 58, Expo Router. Two modes in one app (caregiver, patient). See [docs/02-architecture.md](../../docs/02-architecture.md#mobile-structure-appsmobile).

## Try the Phase 1 gate on a real phone

The gate: **a real phone pairs with a code, and a revoked phone is refused.**

1. Start the backend (repo root): `docker compose up -d --wait`, then in `apps/api`: copy `.env.example` to `.env`, fill the secrets (`openssl rand -base64 32` each), `pnpm db:migrate`, `pnpm build`, `node --env-file=.env dist/main.js`. Keep `DEV_GRANT_STARTER=true` so a new account can add patients (there is no billing yet).
2. Find your computer's LAN address (for example `192.168.1.20`) and open the API port to the phone's network. Put `EXPO_PUBLIC_API_URL=http://192.168.1.20:3000` in `apps/mobile/.env` (see `.env.example`).
3. Start the app: `pnpm --filter @med/mobile exec expo start`. Open it with Expo Go if your Expo Go supports SDK 58 (this slice uses only modules Expo Go includes), or make a development build (`eas build --profile development --platform android`; set `android.package` first, see below).
4. **Phone A (caregiver):** choose *I look after someone's medicines* → create an account → add a patient → *Make a code*.
5. **Phone B (patient):** choose *I take medicines* → agree → scan the QR (or type the code). The caregiver's screen shows *Connected on …*.
6. On phone A press *Disconnect* on that phone. On phone B, press *Refresh* on Today: it shows *Ask your caregiver for a new code*.

Phone A and B can be the same phone: one device holds both modes (D-009), though scanning needs a second screen.

## Before a store build

`android.package` and `ios.bundleIdentifier` are not set in `app.json`: they are permanent once published, so the owner must choose them.

## Tests

`pnpm --filter @med/mobile test` (Jest). Tests live in `tests/` and next to the code they cover, never under `app/`, because every file under `app/` is a route. `pnpm --filter @med/mobile exec expo export --platform android` bundles the app and is run in CI.
