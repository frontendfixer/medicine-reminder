# CLAUDE.md

Standing rules for every agent session in this repo. The project is a medicine reminder app (Expo mobile app + NestJS API). Reminder reliability is the product.

## Before you change anything

1. Read [docs/01-decisions.md](docs/01-decisions.md) before changing behaviour. It is the source of truth.
2. Read the doc for the area you are touching (index: [docs/README.md](docs/README.md)).
3. Check the phase you are in: [docs/13-roadmap.md](docs/13-roadmap.md). Do not build ahead of the current phase's gate.

## Current docs over training data

- Your training data about libraries, SDKs, platform behaviour, store policy and law is assumed out of date.
- Before implementing anything that uses a library, API, SDK, platform behaviour, store policy or law, open its **current official documentation** and read the relevant page.
- Never rely on memory for API names, signatures, permissions, limits or versions. If you cannot reach the docs, stop and say so.
- Name exact versions only after checking them (npm registry, official changelog).

## Keep docs in the same change

- Every source you consult goes in [docs/references.md](docs/references.md): title, URL, version, date checked.
- If your change affects behaviour, schema, API, jobs or ops, update the relevant doc in the same change.
- Names are fixed: tables, columns, statuses (`pending`, `snoozed`, `taken`, `not_taken`, `missed`), notification types (`standard`, `alarm`, `gentle`), endpoint paths. Use the spelling in [docs/03-data-model.md](docs/03-data-model.md) and [docs/04-api.md](docs/04-api.md).

## Ask before contradicting a decision

- If current docs, a bug or a better idea contradicts a decision, do not silently change it.
- Add it to "Conflicts found while documenting" or "Open items" in `docs/01-decisions.md` with the source link and a recommended fix, and ask the owner.
- Open conflicts (C-xx) must be resolved before the phase that implements them.

## Non-negotiables in code

- Postgres is the source of truth for doses and alerts; Redis/BullMQ holds no state we cannot rebuild.
- The phone never computes doses; it schedules only server-issued dose instances, keyed by dose ID.
- Every query is scoped by owner or device; every isolation rule has a test.
- Every write endpoint honours `Idempotency-Key`.
- Never log or send medicine names, notes or photos to Sentry or other third parties.
- All user-facing strings go through translation files.

## Working style

- Small, reviewable changes. Tests with every behaviour change (see [docs/12-testing-and-slos.md](docs/12-testing-and-slos.md)).
- Commit or push only when asked.
