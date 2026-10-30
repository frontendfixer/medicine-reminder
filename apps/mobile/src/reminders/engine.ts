import type { DoseResponseItem, DoseResponseResult, Heartbeat, SyncResult } from '../api/endpoints';
import { ApiError } from '../api/http';
import type { Notifier } from './notifier';
import { diffPlan, ID_PREFIX, planNotifications, type Plan } from './plan';
import type { Action, AnswerResult, Store } from './store';

export interface EngineApi {
  sync(): Promise<SyncResult>;
  respond(responses: DoseResponseItem[]): Promise<{ results: DoseResponseResult[] }>;
  heartbeat(b: Heartbeat): Promise<unknown>;
}
export interface EngineDeps {
  store: Store;
  notifier: Notifier;
  api: EngineApi;
  platform: 'ios' | 'android';
  appVersion: string;
  timeZone: () => string;
  patientId: () => string | null;
  now?: () => number;
  newId: () => string;
}

const FLUSH_BATCH = 100; // docs/04-api.md: at most 100 answers per request
const KEEP_DELIVERED_MS = 7 * 86_400_000;

// The phone's reminder logic (docs/05-reminder-engine.md). The order matters and is deliberate:
//   answer  = write locally first, then cancel what is no longer needed, then try to send (D-031)
//   sync    = send waiting answers, pull the window, replace local state, make the phone's notifications match it
// Anything that fails on the network leaves the phone with a correct local schedule: reminders never depend on being online.
export class RemindersEngine {
  private readonly now: () => number;
  private flushing: Promise<void> | null = null;

  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? Date.now;
  }

  // Makes the notifications on the phone exactly the ones the stored doses call for.
  async reschedule(): Promise<Plan> {
    const { store, notifier } = this.d;
    const lockscreen = (await store.getKv('lockscreen_detail')) === 'generic' ? 'generic' : 'full';
    const windowThrough = Number(await store.getKv('window_through')) || this.now();
    const plan = planNotifications({ doses: await store.listDoses(), now: this.now(), platform: this.d.platform, lockscreen, windowThrough });
    const { cancel, schedule } = diffPlan(plan.planned, await notifier.scheduled());
    await notifier.cancel(cancel);
    const patientId = this.d.patientId() ?? '';
    for (const p of schedule) await notifier.schedule(p, patientId);
    await store.setKv('scheduled_through', plan.scheduledThrough === null ? '' : String(plan.scheduledThrough));
    return plan;
  }

  async sync(): Promise<{ ok: true } | { ok: false; error: unknown }> {
    await this.flush().catch(() => undefined); // answers go first, so the pull below cannot undo them
    let sync: SyncResult;
    try {
      sync = await this.d.api.sync();
    } catch (error) {
      await this.reschedule(); // offline or server trouble: keep the phone's schedule right from what it already holds
      return { ok: false, error };
    }
    if (sync.commands.includes('cancel_all')) {
      // Cutoff (07): no alarms may keep ringing. Local history goes too: the patient is paused.
      await this.d.notifier.cancel((await this.d.notifier.scheduled()).map((s) => s.identifier).filter((id) => id.startsWith(ID_PREFIX)));
      await this.d.store.wipe();
      await this.d.store.setKv('account_state', sync.account_state); // so Today can say "Reminders are paused"
      return { ok: true };
    }
    await this.d.store.applySync(sync);
    await this.reschedule();
    await this.heartbeat().catch(() => undefined); // best effort: the next open or background run tries again
    await this.d.store.purgeDelivered(this.now() - KEEP_DELIVERED_MS);
    return { ok: true };
  }

  // The patient's answer, from the Today screen or the lock screen.
  async answer(doseId: string, action: Action): Promise<AnswerResult> {
    const result = await this.d.store.recordAnswer({ doseId, action, at: this.now(), eventId: this.d.newId() });
    if (!result.ok) return result;
    await this.reschedule(); // an answered dose wants nothing; a snooze wants its new time
    if (action !== 'snooze') await this.d.notifier.dismiss(doseId); // take it out of the shade
    void this.flush().catch(() => undefined); // try to send now; if offline it waits in the queue
    return result;
  }

  // Sends waiting answers. One flush at a time; the server treats a resent answer as a duplicate, so overlap is harmless anyway.
  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const { store, api } = this.d;
    for (;;) {
      const rows = await store.dueOutbox(this.now(), FLUSH_BATCH);
      if (!rows.length) return;
      let results: DoseResponseResult[];
      try {
        ({ results } = await api.respond(
          rows.map((r) => ({ client_event_id: r.clientEventId, dose_id: r.doseId, action: r.action, responded_at: new Date(r.respondedAt).toISOString(), network_restored_at: r.networkRestoredAt ? new Date(r.networkRestoredAt).toISOString() : null })),
        ));
      } catch (e) {
        for (const r of rows) await store.markFailed(r.clientEventId, this.now()); // retry later with a growing wait
        if (e instanceof ApiError && e.code !== 'NETWORK') return; // the server answered and said no: don't hammer it
        throw e;
      }
      let changed = false;
      const answered = new Map(results.map((r) => [r.client_event_id, r]));
      for (const row of rows) {
        const result = answered.get(row.clientEventId);
        if (!result) {
          await store.markFailed(row.clientEventId, this.now());
          continue;
        }
        await store.markDelivered(row.clientEventId, this.now());
        // applied and duplicate: the server agrees with us. superseded (an earlier answer won) or rejected (for example a
        // Snooze it refused): the server's version of the dose replaces our guess.
        if ((result.outcome === 'superseded' || result.outcome === 'rejected') && result.dose) {
          await store.adoptServerState(result.dose);
          changed = true;
        }
      }
      if (changed) await this.reschedule();
      if (rows.length < FLUSH_BATCH) return;
    }
  }

  async heartbeat(): Promise<void> {
    const perms = await this.d.notifier.permissions();
    const through = await this.d.store.getKv('scheduled_through');
    const android = this.d.platform === 'android';
    await this.d.api.heartbeat({
      permissions: { notifications: perms.notifications, ...(android && perms.exactAlarm !== null ? { exact_alarm: perms.exactAlarm } : {}), ...(android && perms.batteryUnrestricted !== null ? { battery_unrestricted: perms.batteryUnrestricted } : {}) },
      app_version: this.d.appVersion,
      tz: this.d.timeZone(),
      scheduled_through: through ? new Date(Number(through)).toISOString() : null,
    });
  }
}
