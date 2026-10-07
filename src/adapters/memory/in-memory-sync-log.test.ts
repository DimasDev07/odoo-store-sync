import { describe, expect, it } from 'vitest';
import { Sku } from '../../domain/product.js';
import { SyncOutcomes } from '../../domain/sync-result.js';
import { InMemorySyncLog } from './in-memory-sync-log.js';

describe('InMemorySyncLog', () => {
  it('keeps entries in recording order', async () => {
    const log = new InMemorySyncLog();
    const entry = (key: string) => ({
      timestamp: new Date('2026-10-08T10:00:00Z'),
      operation: 'stock-update' as const,
      idempotencyKey: key,
      outcome: SyncOutcomes.notFoundInStore(Sku.of('A')),
      attempts: 1,
    });

    await log.record(entry('k1'));
    await log.record(entry('k2'));

    expect(log.entries.map((e) => e.idempotencyKey)).toEqual(['k1', 'k2']);
  });
});
