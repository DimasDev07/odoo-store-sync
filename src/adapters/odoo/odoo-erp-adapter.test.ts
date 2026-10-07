import { describe, expect, it } from 'vitest';
import { ErpAuthError, ErpProtocolError } from '../../domain/errors.js';
import { createStockLevel } from '../../domain/product.js';
import { createFakeFetch, type FakeResponse } from '../test-support/fake-fetch.js';
import { readFixture } from '../test-support/fixtures.js';
import { RecordingLogger } from '../test-support/recording-logger.js';
import { OdooErpAdapter, type OdooErpAdapterOptions } from './odoo-erp-adapter.js';
import { OdooJsonRpcClient } from './odoo-json-rpc-client.js';

const fixture = (name: string): FakeResponse => ({
  body: readFixture(import.meta.url, `fixtures/${name}`),
});

const connection = { url: 'https://erp.example.com', db: 'prod', username: 'u', apiKey: 'k' };

function setup(script: FakeResponse[], options: OdooErpAdapterOptions = {}) {
  const fake = createFakeFetch(script);
  const logger = new RecordingLogger();
  const client = new OdooJsonRpcClient(connection, { fetch: fake.fetch });
  const adapter = new OdooErpAdapter(client, logger, options);
  return { adapter, logger, requests: fake.requests };
}

/** The `execute_kw` arguments of request number `index`: model, method, positional args, kwargs. */
function call(requests: { json(): any }[], index: number) {
  const [, , , model, method, args, kwargs] = requests[index]?.json().params.args;
  return { model, method, args, kwargs };
}

describe('OdooErpAdapter (product.product mode)', () => {
  it('maps default_code and qty_available to stock levels', async () => {
    const { adapter } = setup([fixture('authenticate-ok.json'), fixture('products-page-1.json')]);

    const levels = await adapter.listStockLevels();

    expect(levels).toEqual([
      createStockLevel({ sku: 'DESK-001', quantity: 14, sourceVersion: '2026-10-01 08:15:22' }),
      createStockLevel({ sku: 'CHAIR-002', quantity: 5, sourceVersion: '2026-10-02 09:00:10' }),
      createStockLevel({ sku: 'LAMP-003', quantity: 9, sourceVersion: '2026-10-03 17:42:51' }),
    ]);
  });

  it('queries product.product with a stable order and the default domain', async () => {
    const { adapter, requests } = setup([
      fixture('authenticate-ok.json'),
      fixture('products-page-1.json'),
    ]);

    await adapter.listStockLevels();

    expect(call(requests, 1)).toEqual({
      model: 'product.product',
      method: 'search_read',
      args: [[['type', '!=', 'service']]],
      kwargs: {
        fields: ['default_code', 'qty_available', 'write_date'],
        limit: 500,
        offset: 0,
        order: 'id',
      },
    });
  });

  it('honours a custom product domain', async () => {
    const { adapter, requests } = setup(
      [fixture('authenticate-ok.json'), fixture('empty-result.json')],
      { productDomain: [['is_storable', '=', true]] },
    );

    await adapter.listStockLevels();

    expect(call(requests, 1).args).toEqual([[['is_storable', '=', true]]]);
  });

  it('reads every page until a short page arrives', async () => {
    const { adapter, requests } = setup(
      [
        fixture('authenticate-ok.json'),
        fixture('products-page-1.json'),
        fixture('products-page-2.json'),
      ],
      { pageSize: 3 },
    );

    const levels = await adapter.listStockLevels();

    expect(requests).toHaveLength(3);
    expect(call(requests, 1).kwargs).toMatchObject({ limit: 3, offset: 0 });
    expect(call(requests, 2).kwargs).toMatchObject({ limit: 3, offset: 3 });
    expect(levels.map((level) => level.sku.value)).toEqual([
      'DESK-001',
      'CHAIR-002',
      'LAMP-003',
      'NEG-004',
    ]);
  });

  it('skips products without default_code and logs them once', async () => {
    const { adapter, logger } = setup(
      [
        fixture('authenticate-ok.json'),
        fixture('products-page-1.json'),
        fixture('products-page-2.json'),
      ],
      { pageSize: 3 },
    );

    await adapter.listStockLevels();

    expect(logger.at('warn')).toEqual([
      {
        level: 'warn',
        message: 'Skipped Odoo products without a usable default_code',
        fields: { count: 1, productIds: [15] },
      },
    ]);
  });

  it('never publishes negative stock and rounds fractions down', async () => {
    const { adapter } = setup([fixture('authenticate-ok.json'), fixture('products-page-2.json')]);
    const negative = (await adapter.listStockLevels()).find((l) => l.sku.value === 'NEG-004');

    expect(negative?.quantity).toBe(0);

    const quirks = setup([fixture('authenticate-ok.json'), fixture('products-quirks.json')]);
    const fractional = (await quirks.adapter.listStockLevels()).find(
      (l) => l.sku.value === 'FRAC-005',
    );
    expect(fractional?.quantity).toBe(3);
  });

  it('trims SKUs, treats blank codes as missing and tolerates a missing write_date', async () => {
    const { adapter, logger } = setup([
      fixture('authenticate-ok.json'),
      fixture('products-quirks.json'),
    ]);

    const levels = await adapter.listStockLevels();

    expect(levels.map((level) => level.sku.value)).toEqual(['FRAC-005', 'NO-VERSION-006']);
    expect(levels[1]).not.toHaveProperty('sourceVersion');
    expect(logger.at('warn')[0]?.fields).toEqual({ count: 1, productIds: [20] });
  });

  it('returns a full snapshot even when since is given', async () => {
    const { adapter, requests } = setup([
      fixture('authenticate-ok.json'),
      fixture('products-page-1.json'),
    ]);

    const levels = await adapter.listStockLevels(new Date('2026-10-02T00:00:00Z'));

    expect(levels).toHaveLength(3);
    expect(call(requests, 1).args).toEqual([[['type', '!=', 'service']]]);
  });

  it('is quiet when there is nothing to report', async () => {
    const { adapter, logger } = setup([
      fixture('authenticate-ok.json'),
      fixture('empty-result.json'),
    ]);

    expect(await adapter.listStockLevels()).toEqual([]);
    expect(logger.calls).toEqual([]);
  });

  it('surfaces authentication failures', async () => {
    const { adapter } = setup([fixture('authenticate-rejected.json')]);

    await expect(adapter.listStockLevels()).rejects.toBeInstanceOf(ErpAuthError);
  });

  it('surfaces malformed records as protocol errors', async () => {
    const { adapter } = setup([fixture('authenticate-ok.json'), fixture('products-malformed.json')]);

    await expect(adapter.listStockLevels()).rejects.toBeInstanceOf(ErpProtocolError);
  });
});

describe('OdooErpAdapter (stock.quant mode)', () => {
  const script = () => [
    fixture('authenticate-ok.json'),
    fixture('quants-warehouse-1.json'),
    fixture('products-by-id.json'),
  ];

  it('sums internal quants per product and resolves SKUs in a second query', async () => {
    const { adapter, requests } = setup(script(), { warehouseIds: [1] });

    const levels = await adapter.listStockLevels();

    expect(levels).toEqual([
      createStockLevel({
        sku: 'DESK-001',
        quantity: 14,
        warehouseId: '1',
        sourceVersion: '2026-10-05 16:30:00',
      }),
      createStockLevel({
        sku: 'CHAIR-002',
        quantity: 5,
        warehouseId: '1',
        sourceVersion: '2026-10-02 09:00:10',
      }),
    ]);
    expect(call(requests, 1)).toEqual({
      model: 'stock.quant',
      method: 'search_read',
      args: [[['warehouse_id', 'in', [1]], ['location_id.usage', '=', 'internal']]],
      kwargs: {
        fields: ['product_id', 'quantity', 'write_date'],
        limit: 500,
        offset: 0,
        order: 'id',
      },
    });
    expect(call(requests, 2)).toEqual({
      model: 'product.product',
      method: 'search_read',
      args: [[['id', 'in', [12, 13, 99]]]],
      kwargs: { fields: ['default_code'] },
    });
  });

  it('logs quants whose product has no usable SKU (archived or untagged)', async () => {
    const { adapter, logger } = setup(script(), { warehouseIds: [1] });

    await adapter.listStockLevels();

    expect(logger.at('warn')[0]).toMatchObject({
      message: 'Skipped Odoo products without a usable default_code',
      fields: { count: 1, productIds: [99] },
    });
  });

  it('does not tag levels with a warehouse when several are aggregated', async () => {
    const { adapter } = setup(script(), { warehouseIds: [1, 2] });

    const levels = await adapter.listStockLevels();

    expect(levels[0]).not.toHaveProperty('warehouseId');
  });

  it('pages through quants', async () => {
    const { adapter, requests } = setup(
      [
        fixture('authenticate-ok.json'),
        fixture('quants-warehouse-1.json'),
        fixture('empty-result.json'),
        fixture('products-by-id.json'),
      ],
      { warehouseIds: [1], pageSize: 4 },
    );

    await adapter.listStockLevels();

    expect(call(requests, 2).kwargs).toMatchObject({ limit: 4, offset: 4 });
  });

  it('splits large product lookups into chunks', async () => {
    const quants = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: [
        { id: 1, product_id: [12, 'a'], quantity: 1, write_date: false },
        { id: 2, product_id: [13, 'b'], quantity: 1, write_date: false },
        { id: 3, product_id: [14, 'c'], quantity: 1, write_date: false },
      ],
    });
    const { adapter, requests } = setup(
      [
        fixture('authenticate-ok.json'),
        { body: quants },
        fixture('products-by-id.json'),
        fixture('empty-result.json'),
      ],
      { warehouseIds: [1], productLookupChunkSize: 2 },
    );

    const levels = await adapter.listStockLevels();

    expect(call(requests, 2).args).toEqual([[['id', 'in', [12, 13]]]]);
    expect(call(requests, 3).args).toEqual([[['id', 'in', [14]]]]);
    expect(levels).toHaveLength(2);
    expect(levels[0]).not.toHaveProperty('sourceVersion');
  });

  it('skips the product lookup when there are no quants', async () => {
    const { adapter, requests } = setup(
      [fixture('authenticate-ok.json'), fixture('empty-result.json')],
      { warehouseIds: [1] },
    );

    expect(await adapter.listStockLevels()).toEqual([]);
    expect(requests).toHaveLength(2);
  });
});
