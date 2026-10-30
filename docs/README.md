# Docs index

| File | What it covers |
| --- | --- |
| [00-product-brief.md](00-product-brief.md) | Problem, users, core flows step by step, out of scope |
| [01-decisions.md](01-decisions.md) | Decision log (source of truth), conflicts found, open items |
| [02-architecture.md](02-architecture.md) | Components, how they talk, stack with checked versions |
| [03-data-model.md](03-data-model.md) | Tables, columns, constraints, indexes (Drizzle sketch), ER diagram |
| [04-api.md](04-api.md) | Every endpoint: auth, request/response, errors, idempotency |
| [05-reminder-engine.md](05-reminder-engine.md) | Dose generation, device scheduling, conditional push, sweeper, window, refill, timezone, heartbeat |
| [06-pairing-and-devices.md](06-pairing-and-devices.md) | Pairing and transfer codes, device tokens, device limits, caregiver login, revoke, recovery |
| [07-subscriptions-and-billing.md](07-subscriptions-and-billing.md) | Plans, quota, grace, cutoff, suspension, renewal, RevenueCat |
| [08-notifications-and-platform.md](08-notifications-and-platform.md) | Notification types, Android channels, exact alarms, battery, iOS levels, onboarding, actions |
| [09-missed-dose-alerts.md](09-missed-dose-alerts.md) | Delay resolution, alert rules, grouping, corrections, device problem alerts |
| [10-security-privacy.md](10-security-privacy.md) | Security controls and DPDP mapping |
| [11-failure-modes.md](11-failure-modes.md) | Risk → mitigation table |
| [12-testing-and-slos.md](12-testing-and-slos.md) | Test strategy, device checks, SLOs and measurement |
| [13-roadmap.md](13-roadmap.md) | Phases 1–5 with checklists and gates; v1.1 |
| [14-release-and-ops.md](14-release-and-ops.md) | EAS channels, rollout, minimum version, monitoring, incidents, restore drill |
| [references.md](references.md) | Every source consulted, with version and date checked |

Repo-root [CLAUDE.md](../CLAUDE.md) holds the standing rules for agent sessions.

## Keeping docs current

1. **Decisions first.** A behaviour change starts as a new entry in `01-decisions.md`, or supersedes an old one. Then update the topic docs.
2. **Same change.** Code that changes schema, API, jobs, notifications or ops updates the matching doc in the same commit or PR.
3. **Sources.** Every official page you read goes in `references.md` with the date checked. Re-check sources older than 3 months before relying on them, and always before Phase 1 and Phase 5.
4. **Conflicts.** When current docs contradict a decision, add a `C-xx` entry and ask the owner. Do not edit the decision yourself.
5. **One home per fact.** Each fact lives in one doc; others link to it. Numbers come from `01-decisions.md`.
6. **Roadmap.** Tick `- [x]` items in `13-roadmap.md` as they land, and record gate results with a date.
