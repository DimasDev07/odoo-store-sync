import { errorMessage, isRetryable } from '../../domain/errors.js';
import type { StockLevel } from '../../domain/product.js';
import {
  summarize,
  SyncOutcomes,
  type SyncOutcome,
  type SyncSummary,
} from '../../domain/sync-result.js';
import type { ClockPort } from '../ports/clock-port.js';
import type { ErpPort } from '../ports/erp-port.js';
import type { Job, JobQueuePort } from '../ports/job-queue-port.js';
import type { StorePort } from '../ports/store-port.js';
import type { SyncLogPort } from '../ports/sync-log-port.js';

export interface SyncStockDependencies {
  readonly erp: ErpPort;
  readonly store: StorePort;
  readonly log: SyncLogPort;
  readonly queue: JobQueuePort<StockLevel>;
  readonly clock: ClockPort;
}

export interface SyncStockInput {
  readonly since?: Date;
}

export interface SyncReport {
  readonly outcomes: readonly SyncOutcome[];
  readonly summary: SyncSummary;
}

/**
 * Identifies one unit of stock work. The same SKU at the same quantity and
 * ERP revision is the same job, so it is never applied twice.
 */
export function buildIdempotencyKey(level: StockLevel): string {
  return `${level.sku.value}:${level.quantity}:${level.sourceVersion ?? 'unversioned'}`;
}

export class SyncStock {
  constructor(private readonly deps: SyncStockDependencies) {}

  async execute(input: SyncStockInput = {}): Promise<SyncReport> {
    const { erp, queue } = this.deps;
    const outcomes: SyncOutcome[] = [];

    const levels = await erp.listStockLevels(input.since);
    for (const level of levels) {
      const job = { idempotencyKey: buildIdempotencyKey(level), payload: level };
      if ((await queue.enqueue(job)) === 'duplicate') {
        const outcome = SyncOutcomes.skippedUnchanged(level.sku, level.quantity, 'duplicate-job');
        await this.record(job, outcome, 0, outcomes);
      }
    }

    const run = await queue.process(async (job, attempt) => {
      const outcome = await this.apply(job.payload);
      await this.record(job, outcome, attempt, outcomes);
    });

    for (const { job, attempts, error } of run.failed) {
      const outcome = SyncOutcomes.failed(
        job.payload.sku,
        errorMessage(error),
        isRetryable(error),
        attempts,
      );
      await this.record(job, outcome, attempts, outcomes);
    }

    return { outcomes, summary: summarize(outcomes) };
  }

  private async apply(level: StockLevel): Promise<SyncOutcome> {
    const { store } = this.deps;
    const ref = await store.findProductBySku(level.sku);
    if (ref === null) {
      return SyncOutcomes.notFoundInStore(level.sku);
    }
    if (ref.quantity === level.quantity) {
      return SyncOutcomes.skippedUnchanged(level.sku, level.quantity, 'quantity-equal');
    }
    await store.setStock(ref, level.quantity);
    return SyncOutcomes.updated(level.sku, ref.quantity, level.quantity);
  }

  private async record(
    job: Job<StockLevel>,
    outcome: SyncOutcome,
    attempts: number,
    outcomes: SyncOutcome[],
  ): Promise<void> {
    await this.deps.log.record({
      timestamp: this.deps.clock.now(),
      operation: 'stock-update',
      idempotencyKey: job.idempotencyKey,
      outcome,
      attempts,
    });
    outcomes.push(outcome);
  }
}
