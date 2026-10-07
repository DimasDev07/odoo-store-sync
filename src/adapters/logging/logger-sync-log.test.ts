import { describe, expect, it } from 'vitest';
import type { SyncLogEntry } from '../../application/ports/sync-log-port.js';
import { Sku } from '../../domain/product.js';
import { SyncOutcomes } from '../../domain/sync-result.js';
import { RecordingLogger } from '../test-support/recording-logger.js';
import { LoggerSyncLog } from './logger-sync-log.js';

const sku = Sku.of('A-1');
const entry = (outcome: SyncLogEntry['outcome'], attempts = 1): SyncLogEntry => ({
  timestamp: new Date('2026-10-08T10:00:00.000Z'),
  operation: 'stock-update',
  idempotencyKey: 'A-1:5:v1',
  outcome,
  attempts,
});

async function record(outcome: SyncLogEntry['outcome'], attempts?: number) {
  const logger = new RecordingLogger();
  await new LoggerSyncLog(logger).record(entry(outcome, attempts));
  return logger.calls;
}

describe('LoggerSyncLog', () => {
  it('logs an update at info level with the quantity change', async () => {
    expect(await record(SyncOutcomes.updated(sku, 3, 5))).toEqual([
      {
        level: 'info',
        message: 'stock-update updated',
        fields: {
          operation: 'stock-update',
          outcome: 'updated',
          sku: 'A-1',
          idempotencyKey: 'A-1:5:v1',
          attempts: 1,
          occurredAt: '2026-10-08T10:00:00.000Z',
          previousQuantity: 3,
          newQuantity: 5,
        },
      },
    ]);
  });

  it('logs skipped products at info level with the reason', async () => {
    const [call] = await record(SyncOutcomes.skippedUnchanged(sku, 5, 'quantity-equal'), 1);

    expect(call?.level).toBe('info');
    expect(call?.fields).toMatchObject({ outcome: 'skipped-unchanged', quantity: 5, reason: 'quantity-equal' });
  });

  it('logs products missing in the store at warn level', async () => {
    const [call] = await record(SyncOutcomes.notFoundInStore(sku));

    expect(call?.level).toBe('warn');
    expect(call?.fields).toMatchObject({ outcome: 'not-found-in-store', sku: 'A-1' });
  });

  it('logs failures at error level with reason and attempts', async () => {
    const [call] = await record(SyncOutcomes.failed(sku, 'HTTP 503', true, 4), 4);

    expect(call?.level).toBe('error');
    expect(call?.fields).toMatchObject({
      outcome: 'failed',
      reason: 'HTTP 503',
      retryable: true,
      attempts: 4,
    });
  });
});
