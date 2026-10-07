import { describe, expect, it } from 'vitest';
import type { SyncReport } from './application/use-cases/sync-stock.js';
import { Sku } from './domain/product.js';
import { summarize, SyncOutcomes, type SyncOutcome } from './domain/sync-result.js';
import type { Application } from './infrastructure/composition-root.js';
import { formatReport, runCli } from './main.js';

const sku = (value: string) => Sku.of(value);

function reportOf(outcomes: SyncOutcome[]): SyncReport {
  return { outcomes, summary: summarize(outcomes) };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

function appReturning(execute: () => Promise<SyncReport>): Application {
  return {
    syncStock: { execute } as Application['syncStock'],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

describe('formatReport', () => {
  it('prints an aligned table with one row per outcome and a summary line', () => {
    const text = formatReport(
      reportOf([
        SyncOutcomes.updated(sku('DESK-001'), 10, 14),
        SyncOutcomes.skippedUnchanged(sku('CHAIR-002'), 5, 'quantity-equal'),
        SyncOutcomes.skippedUnchanged(sku('DUP-1'), 5, 'duplicate-job'),
        SyncOutcomes.notFoundInStore(sku('LAMP-003')),
        SyncOutcomes.failed(sku('BAD-4'), 'HTTP 503', true, 4),
        SyncOutcomes.failed(sku('BAD-5'), 'HTTP 401', false, 1),
      ]),
    );

    const row = (skuText: string, outcome: string, detail: string) =>
      `${skuText.padEnd(9)}  ${outcome.padEnd(18)}  ${detail}`;
    expect(text.split('\n')).toEqual([
      row('SKU', 'OUTCOME', 'DETAIL'),
      row('DESK-001', 'updated', '10 -> 14'),
      row('CHAIR-002', 'skipped-unchanged', 'already 5'),
      row('DUP-1', 'skipped-unchanged', 'duplicate job, already handled'),
      row('LAMP-003', 'not-found-in-store', 'no product with this reference in the store'),
      row('BAD-4', 'failed', 'HTTP 503 (4 attempts, retryable)'),
      row('BAD-5', 'failed', 'HTTP 401 (1 attempt)'),
      '',
      'Summary: 6 total | 1 updated | 2 unchanged | 1 not found | 2 failed',
    ]);
  });

  it('handles an empty run', () => {
    expect(formatReport(reportOf([]))).toBe(
      'Nothing to synchronize.\n\nSummary: 0 total | 0 updated | 0 unchanged | 0 not found | 0 failed',
    );
  });
});

describe('runCli', () => {
  it('runs the in-memory demo end to end and exits 0', async () => {
    const { io, stdout, stderr } = capture();

    const code = await runCli({ env: { SYNC_MODE: 'memory' }, ...io });

    expect(code).toBe(0);
    expect(stderr()).toBe('');
    expect(stdout()).toContain('"message":"stock-update updated"');
    expect(stdout()).toMatch(/DESK-001 +updated +10 -> 14/);
    expect(stdout()).toMatch(/CHAIR-002 +skipped-unchanged/);
    expect(stdout()).toMatch(/LAMP-003 +not-found-in-store/);
    expect(stdout()).toContain('Summary: 3 total | 1 updated | 1 unchanged | 1 not found | 0 failed');
  });

  it('defaults to memory mode when nothing is configured', async () => {
    const { io } = capture();

    expect(await runCli({ env: {}, ...io })).toBe(0);
  });

  it('exits 1 when any item failed', async () => {
    const { io, stdout } = capture();
    const failing = reportOf([SyncOutcomes.failed(sku('A'), 'HTTP 503', true, 4)]);

    const code = await runCli({
      env: {},
      ...io,
      composeApp: () => appReturning(async () => failing),
    });

    expect(code).toBe(1);
    expect(stdout()).toContain('failed');
  });

  it('exits 2 and names the problem variables on a configuration error', async () => {
    const { io, stderr, stdout } = capture();

    const code = await runCli({ env: { SYNC_MODE: 'live' }, ...io });

    expect(code).toBe(2);
    expect(stderr()).toContain('ODOO_URL');
    expect(stdout()).toBe('');
  });

  it('exits 1 and prints the message when the run itself blows up', async () => {
    const { io, stderr } = capture();

    const code = await runCli({
      env: {},
      ...io,
      composeApp: () =>
        appReturning(async () => {
          throw new Error('Odoo rejected the credentials');
        }),
    });

    expect(code).toBe(1);
    expect(stderr()).toContain('Sync aborted: Odoo rejected the credentials');
  });
});
