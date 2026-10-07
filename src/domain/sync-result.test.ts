import { describe, expect, it } from 'vitest';
import { Sku } from './product.js';
import { summarize, SyncOutcomes } from './sync-result.js';

const sku = Sku.of('A-1');

describe('SyncOutcomes', () => {
  it('builds an updated outcome with previous and new quantity', () => {
    expect(SyncOutcomes.updated(sku, 3, 8)).toEqual({
      kind: 'updated',
      sku,
      previousQuantity: 3,
      newQuantity: 8,
    });
  });

  it('builds a skipped outcome with the reason it was skipped', () => {
    expect(SyncOutcomes.skippedUnchanged(sku, 3, 'quantity-equal')).toEqual({
      kind: 'skipped-unchanged',
      sku,
      quantity: 3,
      reason: 'quantity-equal',
    });
    expect(SyncOutcomes.skippedUnchanged(sku, 3, 'duplicate-job')).toMatchObject({
      reason: 'duplicate-job',
    });
  });

  it('builds a not-found outcome', () => {
    expect(SyncOutcomes.notFoundInStore(sku)).toEqual({ kind: 'not-found-in-store', sku });
  });

  it('builds a failed outcome', () => {
    expect(SyncOutcomes.failed(sku, 'down', true, 4)).toEqual({
      kind: 'failed',
      sku,
      reason: 'down',
      retryable: true,
      attempts: 4,
    });
  });
});

describe('summarize', () => {
  it('counts outcomes by kind', () => {
    const summary = summarize([
      SyncOutcomes.updated(sku, 1, 2),
      SyncOutcomes.updated(sku, 2, 3),
      SyncOutcomes.skippedUnchanged(sku, 3, 'quantity-equal'),
      SyncOutcomes.notFoundInStore(sku),
      SyncOutcomes.failed(sku, 'x', false, 1),
    ]);

    expect(summary).toEqual({
      total: 5,
      updated: 2,
      skippedUnchanged: 1,
      notFoundInStore: 1,
      failed: 1,
    });
  });

  it('returns zeros for an empty run', () => {
    expect(summarize([])).toEqual({
      total: 0,
      updated: 0,
      skippedUnchanged: 0,
      notFoundInStore: 0,
      failed: 0,
    });
  });
});
