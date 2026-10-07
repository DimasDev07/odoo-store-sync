import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SyncReport } from './application/use-cases/sync-stock.js';
import { errorMessage } from './domain/errors.js';
import type { SyncOutcome } from './domain/sync-result.js';
import { compose } from './infrastructure/composition-root.js';
import { ConfigError, loadConfig } from './infrastructure/config.js';
import { createJsonLogger } from './infrastructure/logger.js';

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Test seam: replaces the composition root. */
  readonly composeApp?: typeof compose;
}

const EXIT_OK = 0;
const EXIT_SYNC_PROBLEM = 1;
const EXIT_BAD_CONFIG = 2;

/** One-shot stock synchronization. Returns the process exit code. */
export async function runCli(io: CliIo): Promise<number> {
  let config;
  try {
    config = loadConfig(io.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(`${error.message}\n`);
      return EXIT_BAD_CONFIG;
    }
    throw error;
  }

  const logger = createJsonLogger({ write: (line) => io.out(`${line}\n`) });
  const { syncStock } = (io.composeApp ?? compose)(config, { logger });

  try {
    const report = await syncStock.execute();
    io.out(`\n${formatReport(report)}\n`);
    return report.summary.failed > 0 ? EXIT_SYNC_PROBLEM : EXIT_OK;
  } catch (error) {
    io.err(`Sync aborted: ${errorMessage(error)}\n`);
    return EXIT_SYNC_PROBLEM;
  }
}

export function formatReport(report: SyncReport): string {
  const { summary } = report;
  const summaryLine =
    `Summary: ${summary.total} total | ${summary.updated} updated | ` +
    `${summary.skippedUnchanged} unchanged | ${summary.notFoundInStore} not found | ${summary.failed} failed`;

  if (report.outcomes.length === 0) {
    return `Nothing to synchronize.\n\n${summaryLine}`;
  }

  const rows = [
    ['SKU', 'OUTCOME', 'DETAIL'],
    ...report.outcomes.map((outcome) => [outcome.sku.value, outcome.kind, describe(outcome)]),
  ] as const;
  const skuWidth = Math.max(...rows.map(([sku]) => sku.length));
  const outcomeWidth = Math.max(...rows.map(([, outcome]) => outcome.length));
  const table = rows.map(
    ([sku, outcome, detail]) => `${sku.padEnd(skuWidth)}  ${outcome.padEnd(outcomeWidth)}  ${detail}`,
  );
  return `${table.join('\n')}\n\n${summaryLine}`;
}

function describe(outcome: SyncOutcome): string {
  switch (outcome.kind) {
    case 'updated':
      return `${outcome.previousQuantity} -> ${outcome.newQuantity}`;
    case 'skipped-unchanged':
      return outcome.reason === 'quantity-equal'
        ? `already ${outcome.quantity}`
        : 'duplicate job, already handled';
    case 'not-found-in-store':
      return 'no product with this reference in the store';
    case 'failed': {
      const attempts = `${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'}`;
      return `${outcome.reason} (${attempts}${outcome.retryable ? ', retryable' : ''})`;
    }
  }
}

// Run only when executed directly (tsx src/main.ts, node dist/main.js), not when imported by tests.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && relative(resolve(entryPoint), fileURLToPath(import.meta.url)) === '') {
  // Values already present in the environment win over the .env file.
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  process.exitCode = await runCli({
    env: process.env,
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  });
}
