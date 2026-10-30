import type { Notifier, Permissions } from '../reminders/notifier';
import type { Planned, Scheduled } from '../reminders/plan';

// Behaves like the OS scheduler where it matters: an ID is unique, and scheduling an existing ID replaces it.
export class FakeNotifier implements Notifier {
  readonly byId = new Map<string, Planned>();
  readonly foreign = new Set<string>(); // notifications that are not ours
  scheduleCalls = 0;
  cancelCalls: string[] = [];
  dismissed: string[] = [];
  perms: Permissions = { notifications: true, exactAlarm: true, batteryUnrestricted: true };

  scheduled(): Promise<Scheduled[]> {
    const ours: Scheduled[] = [...this.byId.values()].map((p) => ({ identifier: p.identifier, hash: p.hash }));
    return Promise.resolve(ours.concat([...this.foreign].map((identifier) => ({ identifier, hash: null }))));
  }
  schedule(p: Planned): Promise<void> {
    this.scheduleCalls++;
    this.byId.set(p.identifier, p);
    return Promise.resolve();
  }
  cancel(ids: string[]): Promise<void> {
    this.cancelCalls.push(...ids);
    for (const id of ids) {
      this.byId.delete(id);
      this.foreign.delete(id);
    }
    return Promise.resolve();
  }
  dismiss(doseId: string): Promise<void> {
    this.dismissed.push(doseId);
    return Promise.resolve();
  }
  permissions = (): Promise<Permissions> => Promise.resolve(this.perms);
  ids = (): string[] => [...this.byId.keys()].sort();
}
