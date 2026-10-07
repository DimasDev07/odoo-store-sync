import type { SyncLogEntry, SyncLogPort } from '../../application/ports/sync-log-port.js';

export class InMemorySyncLog implements SyncLogPort {
  readonly entries: SyncLogEntry[] = [];

  async record(entry: SyncLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}
