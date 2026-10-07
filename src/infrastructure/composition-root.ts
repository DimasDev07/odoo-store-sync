import { SyncStock } from '../application/use-cases/sync-stock.js';
import type { ClockPort } from '../application/ports/clock-port.js';
import type { ErpPort } from '../application/ports/erp-port.js';
import type { LoggerPort } from '../application/ports/logger-port.js';
import type { StorePort } from '../application/ports/store-port.js';
import { LoggerSyncLog } from '../adapters/logging/logger-sync-log.js';
import { createDemoSeed } from '../adapters/memory/demo-seed.js';
import { InMemoryErp } from '../adapters/memory/in-memory-erp.js';
import { InMemoryJobQueue } from '../adapters/memory/in-memory-job-queue.js';
import { InMemoryStore } from '../adapters/memory/in-memory-store.js';
import { OdooErpAdapter } from '../adapters/odoo/odoo-erp-adapter.js';
import { OdooJsonRpcClient } from '../adapters/odoo/odoo-json-rpc-client.js';
import { PrestaShopStoreAdapter } from '../adapters/prestashop/prestashop-store-adapter.js';
import { PrestaShopWebserviceClient } from '../adapters/prestashop/prestashop-webservice-client.js';
import { errorMessage } from '../domain/errors.js';
import type { StockLevel } from '../domain/product.js';
import type { AppConfig } from './config.js';
import { createJsonLogger } from './logger.js';
import { createRetryRunner } from './retry.js';
import { SystemClock } from './system-clock.js';

export interface Application {
  readonly syncStock: SyncStock;
  readonly logger: LoggerPort;
}

/** Test seams. Production code passes nothing. */
export interface CompositionOverrides {
  readonly logger?: LoggerPort;
  readonly clock?: ClockPort;
  readonly fetch?: typeof fetch;
  readonly random?: () => number;
}

/** The only place that knows which concrete classes implement the ports. */
export function compose(config: AppConfig, overrides: CompositionOverrides = {}): Application {
  const logger = overrides.logger ?? createJsonLogger();
  const clock = overrides.clock ?? new SystemClock();

  const retry = createRetryRunner({
    ...config.retry,
    clock,
    ...(overrides.random !== undefined && { random: overrides.random }),
    onRetry: ({ attempt, delayMs, error }) =>
      logger.warn('Retrying after transient error', { attempt, delayMs, error: errorMessage(error) }),
  });

  const { erp, store } =
    config.mode === 'memory' ? memoryBackends() : liveBackends(config, logger, overrides.fetch);

  return {
    logger,
    syncStock: new SyncStock({
      erp,
      store,
      clock,
      log: new LoggerSyncLog(logger),
      queue: new InMemoryJobQueue<StockLevel>({ retry }),
    }),
  };
}

function memoryBackends(): { erp: ErpPort; store: StorePort } {
  const seed = createDemoSeed();
  return { erp: new InMemoryErp(seed.erpLevels), store: new InMemoryStore(seed.storeStock) };
}

function liveBackends(
  config: Extract<AppConfig, { mode: 'live' }>,
  logger: LoggerPort,
  fetchFn: typeof fetch | undefined,
): { erp: ErpPort; store: StorePort } {
  const clientOptions = fetchFn === undefined ? {} : { fetch: fetchFn };
  const odoo = new OdooJsonRpcClient(config.odoo, clientOptions);
  const prestashop = new PrestaShopWebserviceClient(config.prestashop, clientOptions);
  return {
    erp: new OdooErpAdapter(odoo, logger, { warehouseIds: config.odoo.warehouseIds }),
    store: new PrestaShopStoreAdapter(prestashop),
  };
}
