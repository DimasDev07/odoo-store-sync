import type { SyncOutcome } from '../../domain/sync-result.js';

export interface SyncLogEntry {
  readonly timestamp: Date;
  readonly operation: 'stock-update';
  readonly idempotencyKey: string;
  readonly outcome: SyncOutcome;
  /** How many times the operation was attempted before this outcome. */
  readonly attempts: number;
}

export interface SyncLogPort {
  record(entry: SyncLogEntry): Promise<void>;
}
