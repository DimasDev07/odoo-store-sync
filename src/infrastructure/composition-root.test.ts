import { describe, expect, it } from 'vitest';
import { FakeClock } from '../adapters/memory/fake-clock.js';
import {
  createFakeFetch,
  type FakeResponse,
  type RecordedRequest,
} from '../adapters/test-support/fake-fetch.js';
import { readFixture } from '../adapters/test-support/fixtures.js';
import { RecordingLogger } from '../adapters/test-support/recording-logger.js';
import { loadConfig } from './config.js';
import { compose } from './composition-root.js';

const START = new Date('2026-10-08T10:00:00.000Z');

describe('compose (memory mode)', () => {
  it('wires the in-memory demo: one updated, one unchanged, one missing in the store', async () => {
    const logger = new RecordingLogger();
    const { syncStock } = compose(loadConfig({ SYNC_MODE: 'memory' }), {
      logger,
      clock: new FakeClock(START),
    });

    const report = await syncStock.execute();

    expect(report.outcomes.map((outcome) => `${outcome.sku.value}:${outcome.kind}`)).toEqual([
      'DESK-001:updated',
      'CHAIR-002:skipped-unchanged',
      'LAMP-003:not-found-in-store',
    ]);
    expect(report.summary).toMatchObject({ total: 3, updated: 1, skippedUnchanged: 1, notFoundInStore: 1 });
    expect(logger.calls.map((call) => call.fields?.['outcome'])).toEqual([
      'updated',
      'skipped-unchanged',
      'not-found-in-store',
    ]);
  });
});

describe('compose (live mode, HTTP faked)', () => {
  const liveConfig = () =>
    loadConfig({
      SYNC_MODE: 'live',
      ODOO_URL: 'https://erp.example.com',
      ODOO_DB: 'prod',
      ODOO_USERNAME: 'sync@example.com',
      ODOO_API_KEY: 'odoo-secret',
      PRESTASHOP_URL: 'https://shop.example.com',
      PRESTASHOP_WS_KEY: 'ps-secret',
      SYNC_BASE_DELAY_MS: '100',
    });

  const odooFixture = (name: string): FakeResponse => ({
    body: readFixture(import.meta.url, `../adapters/odoo/fixtures/${name}`),
  });
  const shopFixture = (name: string, status = 200): FakeResponse => ({
    status,
    body: readFixture(import.meta.url, `../adapters/prestashop/fixtures/${name}`),
    contentType: 'application/xml',
  });

  /** Odoo has 3 products; the shop only knows DESK-001 (10 units). */
  function fakeBackends(options: { shopFailures?: number } = {}) {
    let shopFailures = options.shopFailures ?? 0;
    return createFakeFetch((request: RecordedRequest): FakeResponse => {
      const url = new URL(request.url);
      if (url.hostname === 'erp.example.com') {
        return request.json().params.service === 'common'
          ? odooFixture('authenticate-ok.json')
          : odooFixture('products-page-1.json');
      }
      if (url.pathname === '/api/products') {
        if (shopFailures > 0) {
          shopFailures -= 1;
          return shopFixture('error-server.xml', 503);
        }
        return request.url.includes('[DESK-001]')
          ? shopFixture('products-found.xml')
          : shopFixture('products-empty.xml');
      }
      return url.pathname === '/api/stock_availables'
        ? shopFixture('stock-availables-by-product.xml')
        : shopFixture('stock-available-single.xml');
    });
  }

  it('syncs Odoo stock into PrestaShop through the real adapters', async () => {
    const fake = fakeBackends();
    const { syncStock } = compose(liveConfig(), {
      fetch: fake.fetch,
      logger: new RecordingLogger(),
      clock: new FakeClock(START),
    });

    const report = await syncStock.execute();

    expect(report.outcomes.map((outcome) => `${outcome.sku.value}:${outcome.kind}`)).toEqual([
      'DESK-001:updated',
      'CHAIR-002:not-found-in-store',
      'LAMP-003:not-found-in-store',
    ]);
    const put = fake.requests.find((request) => request.method === 'PUT');
    expect(put?.url).toBe('https://shop.example.com/api/stock_availables/34');
    expect(put?.body).toContain('<quantity>14</quantity>');
  });

  it('retries transient store failures with backoff before giving up', async () => {
    const fake = fakeBackends({ shopFailures: 2 });
    const clock = new FakeClock(START);
    const logger = new RecordingLogger();
    const { syncStock } = compose(liveConfig(), {
      fetch: fake.fetch,
      logger,
      clock,
      random: () => 1,
    });

    const report = await syncStock.execute();

    expect(report.outcomes[0]).toMatchObject({ kind: 'updated' });
    expect(clock.sleeps).toEqual([100, 200]);
    expect(logger.at('warn').filter((call) => call.message === 'Retrying after transient error')).toHaveLength(2);
    const firstEntry = logger.calls.find((call) => call.fields?.['sku'] === 'DESK-001');
    expect(firstEntry?.fields).toMatchObject({ attempts: 3 });
  });

  it('reports a failure once attempts are exhausted', async () => {
    const fake = fakeBackends({ shopFailures: 99 });
    const { syncStock } = compose(liveConfig(), {
      fetch: fake.fetch,
      logger: new RecordingLogger(),
      clock: new FakeClock(START),
    });

    const report = await syncStock.execute();

    expect(report.summary.failed).toBe(3);
    expect(report.outcomes[0]).toMatchObject({ kind: 'failed', retryable: true, attempts: 4 });
  });
});
