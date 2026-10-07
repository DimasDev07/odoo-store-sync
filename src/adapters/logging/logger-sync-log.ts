import type { LoggerPort, LogFields } from '../../application/ports/logger-port.js';
import type { SyncLogEntry, SyncLogPort } from '../../application/ports/sync-log-port.js';
import type { SyncOutcome } from '../../domain/sync-result.js';

/**
 * Writes the per-operation sync log as structured log lines (one per outcome).
 * A database-backed log is on the roadmap; this keeps the slice dependency-free.
 */
export class LoggerSyncLog implements SyncLogPort {
  constructor(private readonly logger: LoggerPort) {}

  async record(entry: SyncLogEntry): Promise<void> {
    const { outcome } = entry;
    const fields: LogFields = {
      operation: entry.operation,
      outcome: outcome.kind,
      sku: outcome.sku.value,
      idempotencyKey: entry.idempotencyKey,
      attempts: entry.attempts,
      occurredAt: entry.timestamp.toISOString(),
      ...details(outcome),
    };
    const message = `${entry.operation} ${outcome.kind}`;

    switch (outcome.kind) {
      case 'updated':
      case 'skipped-unchanged':
        this.logger.info(message, fields);
        break;
      case 'not-found-in-store':
        this.logger.warn(message, fields);
        break;
      case 'failed':
        this.logger.error(message, fields);
        break;
    }
  }
}

function details(outcome: SyncOutcome): LogFields {
  switch (outcome.kind) {
    case 'updated':
      return { previousQuantity: outcome.previousQuantity, newQuantity: outcome.newQuantity };
    case 'skipped-unchanged':
      return { quantity: outcome.quantity, reason: outcome.reason };
    case 'failed':
      return { reason: outcome.reason, retryable: outcome.retryable };
    case 'not-found-in-store':
      return {};
  }
}
