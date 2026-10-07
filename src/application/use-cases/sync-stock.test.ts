import { describe, expect, it } from 'vitest';
import { isRetryable, StoreAuthError, StoreUnavailableError } from '../../domain/errors.js';
import { createStockLevel, Sku, type StockLevel } from '../../domain/product.js';
import type { ClockPort } from '../ports/clock-port.js';
import type { ErpPort } from '../ports/erp-port.js';
import type {
  EnqueueResult,
  FailedJob,
  Job,
  JobHandler,
  JobQueuePort,
  QueueRunSummary,
} from '../ports/job-queue-port.js';
import type { StorePort, StoreProductRef } from '../ports/store-port.js';
import type { SyncLogEntry, SyncLogPort } from '../ports/sync-log-port.js';
import { buildIdempotencyKey, SyncStock } from './sync-stock.js';

// Minimal test doubles. They are replaced by the in-memory adapters once those exist.

class StubErp implements ErpPort {
  sinceArgs: (Date | undefined)[] = [];
  error: Error | undefined;
  constructor(public levels: StockLevel[]) {}
  async listStockLevels(since?: Date): Promise<StockLevel[]> {
    this.sinceArgs.push(since);
    if (this.error) throw this.error;
    return this.levels;
  }
}

class StubStore implements StorePort {
  setCalls: { sku: string; quantity: number }[] = [];
  failures = new Map<string, unknown>();
  constructor(readonly stock: Map<string, number>) {}
  async findProductBySku(sku: Sku): Promise<StoreProductRef | null> {
    const failure = this.failures.get(sku.value);
    if (failure) throw failure;
    const quantity = this.stock.get(sku.value);
    return quantity === undefined ? null : { id: `id-${sku.value}`, sku, quantity };
  }
  async setStock(ref: StoreProductRef, quantity: number): Promise<void> {
    this.setCalls.push({ sku: ref.sku.value, quantity });
    this.stock.set(ref.sku.value, quantity);
  }
}

class StubLog implements SyncLogPort {
  entries: SyncLogEntry[] = [];
  async record(entry: SyncLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class StubQueue<T> implements JobQueuePort<T> {
  private accepted = new Set<string>();
  private pending: Job<T>[] = [];
  constructor(private readonly maxAttempts = 3) {}
  async enqueue(job: Job<T>): Promise<EnqueueResult> {
    if (this.accepted.has(job.idempotencyKey)) return 'duplicate';
    this.accepted.add(job.idempotencyKey);
    this.pending.push(job);
    return 'enqueued';
  }
  async process(handler: JobHandler<T>): Promise<QueueRunSummary<T>> {
    let succeeded = 0;
    const failed: FailedJob<T>[] = [];
    for (const job of this.pending.splice(0)) {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          await handler(job, attempt);
          succeeded += 1;
          break;
        } catch (error) {
          if (isRetryable(error) && attempt < this.maxAttempts) continue;
          this.accepted.delete(job.idempotencyKey);
          failed.push({ job, attempts: attempt, error });
          break;
        }
      }
    }
    return { succeeded, failed };
  }
}

const NOW = new Date('2026-10-08T10:00:00.000Z');
const clock: ClockPort = { now: () => NOW, sleep: async () => {} };

const level = (sku: string, quantity: number, sourceVersion = 'v1'): StockLevel =>
  createStockLevel({ sku, quantity, sourceVersion });

function setup(options: { erp: StockLevel[]; store: Record<string, number>; maxAttempts?: number }) {
  const erp = new StubErp(options.erp);
  const store = new StubStore(new Map(Object.entries(options.store)));
  const log = new StubLog();
  const queue = new StubQueue<StockLevel>(options.maxAttempts);
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

    expect(store.setCalls).toEqual([{ sku: 'A', quantity: 10 }]);
    expect(report.outcomes).toEqual([
      { kind: 'updated', sku: Sku.of('A'), previousQuantity: 4, newQuantity: 10 },
    ]);
  });

  it('does not touch the store when the quantity is already correct', async () => {
    const { useCase, store } = setup({ erp: [level('A', 4)], store: { A: 4 } });

    const report = await useCase.execute();

    expect(store.setCalls).toEqual([]);
    expect(report.outcomes).toEqual([
      { kind: 'skipped-unchanged', sku: Sku.of('A'), quantity: 4, reason: 'quantity-equal' },
    ]);
  });

  it('reports SKUs that do not exist in the store', async () => {
    const { useCase, store } = setup({ erp: [level('GHOST', 1)], store: {} });

    const report = await useCase.execute();

    expect(store.setCalls).toEqual([]);
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
    erp.error = new Error('erp down');

    await expect(useCase.execute()).rejects.toThrow('erp down');
  });

  describe('idempotency', () => {
    it('applies the same key only once within a run', async () => {
      const { useCase, store } = setup({
        erp: [level('A', 10), level('A', 10)],
        store: { A: 4 },
      });

      const report = await useCase.execute();

      expect(store.setCalls).toHaveLength(1);
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
      store.stock.set('A', 7); // someone edits the store by hand between runs
      store.setCalls.length = 0;

      const report = await useCase.execute();

      expect(store.setCalls).toEqual([]);
      expect(report.outcomes).toEqual([
        { kind: 'skipped-unchanged', sku: Sku.of('A'), quantity: 10, reason: 'duplicate-job' },
      ]);
    });

    it('treats a new source version as new work', async () => {
      const { useCase, erp, store } = setup({ erp: [level('A', 10, 'v1')], store: { A: 4 } });
      await useCase.execute();
      erp.levels = [level('A', 10, 'v2')];
      store.stock.set('A', 3);

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
      store.failures.set('A', new StoreUnavailableError('503 from store'));

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
      store.failures.set('A', new StoreAuthError('401'));

      const report = await useCase.execute();

      expect(report.outcomes).toEqual([
        { kind: 'failed', sku: Sku.of('A'), reason: '401', retryable: false, attempts: 1 },
      ]);
    });

    it('describes errors that are not Error instances', async () => {
      const { useCase, store } = setup({ erp: [level('A', 10)], store: { A: 4 } });
      store.failures.set('A', 'weird failure');

      const report = await useCase.execute();

      expect(report.outcomes[0]).toMatchObject({ kind: 'failed', reason: 'weird failure' });
    });

    it('lets a later run retry a job that failed for good', async () => {
      const { useCase, store } = setup({ erp: [level('A', 10)], store: { A: 4 } });
      store.failures.set('A', new StoreAuthError('401'));
      await useCase.execute();
      store.failures.clear();

      const report = await useCase.execute();

      expect(report.outcomes[0]).toMatchObject({ kind: 'updated', newQuantity: 10 });
    });

    it('keeps processing the rest of the batch after a failure', async () => {
      const { useCase, store } = setup({
        erp: [level('BAD', 1), level('GOOD', 5)],
        store: { BAD: 0, GOOD: 0 },
      });
      store.failures.set('BAD', new StoreAuthError('401'));

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
