import { describe, expect, it } from 'vitest';
import { StoreAuthError, StoreUnavailableError } from '../../domain/errors.js';
import { createStockLevel, Sku, type StockLevel } from '../../domain/product.js';
import { InMemoryErp } from '../../adapters/memory/in-memory-erp.js';
import { InMemoryJobQueue } from '../../adapters/memory/in-memory-job-queue.js';
import { InMemoryStore } from '../../adapters/memory/in-memory-store.js';
import { InMemorySyncLog } from '../../adapters/memory/in-memory-sync-log.js';
import { FakeClock } from '../../adapters/memory/fake-clock.js';
import { immediateRetry } from '../../adapters/test-support/retry-runner.js';
import { buildIdempotencyKey, SyncStock } from './sync-stock.js';

const NOW = new Date('2026-10-08T10:00:00.000Z');

const level = (sku: string, quantity: number, sourceVersion = 'v1'): StockLevel =>
  createStockLevel({ sku, quantity, sourceVersion });

function setup(options: { erp: StockLevel[]; store: Record<string, number>; maxAttempts?: number }) {
  const erp = new InMemoryErp(options.erp);
  const store = new InMemoryStore(options.store);
  const log = new InMemorySyncLog();
  const queue = new InMemoryJobQueue<StockLevel>({
    retry: immediateRetry(options.maxAttempts ?? 3),
  });
  const clock = new FakeClock(NOW);
  const useCase = new SyncStock({ erp, store, log, queue, clock });
  return { erp, store, log, queue, useCase };
}

describe('buildIdempotencyKey', () => {
  it('combines sku, quantity and source version', () => {
    expect(buildIdempotencyKey(level('A-1', 5, '2026-10-08 09:00:00'))).toBe(
      'A-1:5:2026-10-08 09:00:00',
    );
  });

  it('falls back to a fixed marker when the ERP gives no version', () => {
    expect(buildIdempotencyKey(createStockLevel({ sku: 'A-1', quantity: 5 }))).toBe(
      'A-1:5:unversioned',
    );
  });
});

describe('SyncStock', () => {
  it('updates the store when quantities differ', async () => {
    const { useCase, store } = setup({ erp: [level('A', 10)], store: { A: 4 } });

    const report = await useCase.execute();

    expect(store.setStockCalls).toEqual([{ sku: 'A', quantity: 10 }]);
    expect(report.outcomes).toEqual([
      { kind: 'updated', sku: Sku.of('A'), previousQuantity: 4, newQuantity: 10 },
    ]);
  });

  it('does not touch the store when the quantity is already correct', async () => {
    const { useCase, store } = setup({ erp: [level('A', 4)], store: { A: 4 } });

    const report = await useCase.execute();

    expect(store.setStockCalls).toEqual([]);
    expect(report.outcomes).toEqual([
      { kind: 'skipped-unchanged', sku: Sku.of('A'), quantity: 4, reason: 'quantity-equal' },
    ]);
  });

  it('reports SKUs that do not exist in the store', async () => {
    const { useCase, store } = setup({ erp: [level('GHOST', 1)], store: {} });

    const report = await useCase.execute();

    expect(store.setStockCalls).toEqual([]);
    expect(report.outcomes).toEqual([{ kind: 'not-found-in-store', sku: Sku.of('GHOST') }]);
  });

  it('handles a mixed batch and summarizes it', async () => {
    const { useCase } = setup({
      erp: [level('UP', 9), level('SAME', 2), level('MISSING', 1)],
      store: { UP: 1, SAME: 2 },
    });

    const report = await useCase.execute();

    expect(report.outcomes.map((outcome) => outcome.kind)).toEqual([
      'updated',
      'skipped-unchanged',
      'not-found-in-store',
    ]);
    expect(report.summary).toEqual({
      total: 3,
      updated: 1,
      skippedUnchanged: 1,
      notFoundInStore: 1,
      failed: 0,
    });
  });

  it('forwards the since filter to the ERP', async () => {
    const since = new Date('2026-10-01T00:00:00Z');
    const { useCase, erp } = setup({ erp: [], store: {} });

    await useCase.execute({ since });
    await useCase.execute();

    expect(erp.sinceArgs).toEqual([since, undefined]);
  });

  it('lets ERP failures surface: there is nothing to sync without a source', async () => {
    const { useCase, erp } = setup({ erp: [], store: {} });
    erp.failWith(new Error('erp down'));

    await expect(useCase.execute()).rejects.toThrow('erp down');
  });

  describe('idempotency', () => {
    it('applies the same key only once within a run', async () => {
      const { useCase, store } = setup({
        erp: [level('A', 10), level('A', 10)],
        store: { A: 4 },
      });

      const report = await useCase.execute();

      expect(store.setStockCalls).toHaveLength(1);
      expect(report.outcomes).toContainEqual({
        kind: 'skipped-unchanged',
        sku: Sku.of('A'),
        quantity: 10,
        reason: 'duplicate-job',
      });
      expect(report.outcomes.filter((outcome) => outcome.kind === 'updated')).toHaveLength(1);
    });

    it('does not re-apply a change already processed in an earlier run', async () => {
      const { useCase, store } = setup({ erp: [level('A', 10, 'v1')], store: { A: 4 } });
      await useCase.execute();
      store.setQuantity('A', 7); // someone edits the store by hand between runs
      store.setStockCalls.length = 0;

      const report = await useCase.execute();

      expect(store.setStockCalls).toEqual([]);
      expect(report.outcomes).toEqual([
        { kind: 'skipped-unchanged', sku: Sku.of('A'), quantity: 10, reason: 'duplicate-job' },
      ]);
    });

    it('treats a new source version as new work', async () => {
      const { useCase, erp, store } = setup({ erp: [level('A', 10, 'v1')], store: { A: 4 } });
      await useCase.execute();
      erp.setLevels([level('A', 10, 'v2')]);
      store.setQuantity('A', 3);

      const report = await useCase.execute();

      expect(report.outcomes[0]).toMatchObject({ kind: 'updated', previousQuantity: 3 });
    });
  });

  describe('failures', () => {
    it('retries transient store errors and reports the attempts when it gives up', async () => {
      const { useCase, store, log } = setup({
        erp: [level('A', 10)],
        store: { A: 4 },
        maxAttempts: 3,
      });
      store.failOn('A', new StoreUnavailableError('503 from store'));

      const report = await useCase.execute();

      expect(report.outcomes).toEqual([
        {
          kind: 'failed',
          sku: Sku.of('A'),
          reason: '503 from store',
          retryable: true,
          attempts: 3,
        },
      ]);
      expect(report.summary.failed).toBe(1);
      expect(log.entries.at(-1)).toMatchObject({ attempts: 3, outcome: { kind: 'failed' } });
    });

    it('does not retry permanent errors', async () => {
      const { useCase, store } = setup({ erp: [level('A', 10)], store: { A: 4 } });
      store.failOn('A', new StoreAuthError('401'));

      const report = await useCase.execute();

      expect(report.outcomes).toEqual([
        { kind: 'failed', sku: Sku.of('A'), reason: '401', retryable: false, attempts: 1 },
      ]);
    });

    it('lets a later run retry a job that failed for good', async () => {
      const { useCase, store } = setup({ erp: [level('A', 10)], store: { A: 4 } });
      store.failOn('A', new StoreAuthError('401'));
      await useCase.execute();
      store.clearFailures();

      const report = await useCase.execute();

      expect(report.outcomes[0]).toMatchObject({ kind: 'updated', newQuantity: 10 });
    });

    it('keeps processing the rest of the batch after a failure', async () => {
      const { useCase, store } = setup({
        erp: [level('BAD', 1), level('GOOD', 5)],
        store: { BAD: 0, GOOD: 0 },
      });
      store.failOn('BAD', new StoreAuthError('401'));

      const report = await useCase.execute();

      expect(report.summary).toMatchObject({ failed: 1, updated: 1 });
    });
  });

  describe('sync log', () => {
    it('records one entry per outcome with key, attempt and clock time', async () => {
      const { useCase, log } = setup({
        erp: [level('UP', 9, 'v7'), level('MISSING', 1, 'v7')],
        store: { UP: 1 },
      });

      await useCase.execute();

      expect(log.entries).toEqual([
        {
          timestamp: NOW,
          operation: 'stock-update',
          idempotencyKey: 'UP:9:v7',
          attempts: 1,
          outcome: { kind: 'updated', sku: Sku.of('UP'), previousQuantity: 1, newQuantity: 9 },
        },
        {
          timestamp: NOW,
          operation: 'stock-update',
          idempotencyKey: 'MISSING:1:v7',
          attempts: 1,
          outcome: { kind: 'not-found-in-store', sku: Sku.of('MISSING') },
        },
      ]);
    });

    it('logs duplicates too, so every ERP level leaves a trace', async () => {
      const { useCase, log } = setup({ erp: [level('A', 1), level('A', 1)], store: { A: 0 } });

      await useCase.execute();

      expect(log.entries).toHaveLength(2);
    });
  });
});
