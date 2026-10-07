import type { Sku } from './product.js';

export type SkipReason = 'quantity-equal' | 'duplicate-job';

export type SyncOutcome =
  | {
      readonly kind: 'updated';
      readonly sku: Sku;
      readonly previousQuantity: number;
      readonly newQuantity: number;
    }
  | {
      readonly kind: 'skipped-unchanged';
      readonly sku: Sku;
      readonly quantity: number;
      readonly reason: SkipReason;
    }
  | { readonly kind: 'not-found-in-store'; readonly sku: Sku }
  | {
      readonly kind: 'failed';
      readonly sku: Sku;
      readonly reason: string;
      readonly retryable: boolean;
      readonly attempts: number;
    };

export const SyncOutcomes = {
  updated: (sku: Sku, previousQuantity: number, newQuantity: number): SyncOutcome => ({
    kind: 'updated',
    sku,
    previousQuantity,
    newQuantity,
  }),
  skippedUnchanged: (sku: Sku, quantity: number, reason: SkipReason): SyncOutcome => ({
    kind: 'skipped-unchanged',
    sku,
    quantity,
    reason,
  }),
  notFoundInStore: (sku: Sku): SyncOutcome => ({ kind: 'not-found-in-store', sku }),
  failed: (sku: Sku, reason: string, retryable: boolean, attempts: number): SyncOutcome => ({
    kind: 'failed',
    sku,
    reason,
    retryable,
    attempts,
  }),
} as const;

export interface SyncSummary {
  readonly total: number;
  readonly updated: number;
  readonly skippedUnchanged: number;
  readonly notFoundInStore: number;
  readonly failed: number;
}

export function summarize(outcomes: readonly SyncOutcome[]): SyncSummary {
  const count = (kind: SyncOutcome['kind']): number =>
    outcomes.filter((outcome) => outcome.kind === kind).length;
  return {
    total: outcomes.length,
    updated: count('updated'),
    skippedUnchanged: count('skipped-unchanged'),
    notFoundInStore: count('not-found-in-store'),
    failed: count('failed'),
  };
}
