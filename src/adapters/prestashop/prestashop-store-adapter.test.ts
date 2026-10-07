import { describe, expect, it } from 'vitest';
import { StoreProtocolError } from '../../domain/errors.js';
import { Sku } from '../../domain/product.js';
import { createFakeFetch, type FakeResponse } from '../test-support/fake-fetch.js';
import { readFixture } from '../test-support/fixtures.js';
import { PrestaShopStoreAdapter } from './prestashop-store-adapter.js';
import { PrestaShopWebserviceClient } from './prestashop-webservice-client.js';

const xml = (name: string): FakeResponse => ({
  body: readFixture(import.meta.url, `fixtures/${name}`),
  contentType: 'application/xml',
});

function setup(script: FakeResponse[]) {
  const fake = createFakeFetch(script);
  const client = new PrestaShopWebserviceClient(
    { url: 'https://shop.example.com', wsKey: 'k' },
    { fetch: fake.fetch },
  );
  return { adapter: new PrestaShopStoreAdapter(client), requests: fake.requests };
}

describe('PrestaShopStoreAdapter.findProductBySku', () => {
  it('resolves the product and its stock record into a reference', async () => {
    const { adapter } = setup([xml('products-found.xml'), xml('stock-availables-by-product.xml')]);

    const ref = await adapter.findProductBySku(Sku.of('DESK-001'));

    expect(ref).toEqual({ id: '34', sku: Sku.of('DESK-001'), quantity: 10 });
  });

  it('returns null when no product has that reference, without reading stock', async () => {
    const { adapter, requests } = setup([xml('products-empty.xml')]);

    expect(await adapter.findProductBySku(Sku.of('NOPE'))).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('refuses to guess when several products share the reference', async () => {
    const { adapter } = setup([xml('products-duplicate-reference.xml')]);

    await expect(adapter.findProductBySku(Sku.of('DESK-001'))).rejects.toThrow(
      /2 products share reference DESK-001/,
    );
  });

  it('fails when a product has no stock record', async () => {
    const { adapter } = setup([xml('products-found.xml'), xml('stock-availables-empty.xml')]);

    await expect(adapter.findProductBySku(Sku.of('DESK-001'))).rejects.toBeInstanceOf(
      StoreProtocolError,
    );
  });

  it('fails on multistore setups, which are not supported yet', async () => {
    const { adapter } = setup([xml('products-found.xml'), xml('stock-availables-multistore.xml')]);

    await expect(adapter.findProductBySku(Sku.of('DESK-001'))).rejects.toThrow(/multistore/);
  });

  it('fails when the quantity is not a whole number', async () => {
    const { adapter } = setup([
      xml('products-found.xml'),
      xml('stock-availables-bad-quantity.xml'),
    ]);

    await expect(adapter.findProductBySku(Sku.of('DESK-001'))).rejects.toBeInstanceOf(
      StoreProtocolError,
    );
  });
});

describe('PrestaShopStoreAdapter.setStock', () => {
  it('updates the stock record the reference points to', async () => {
    const { adapter, requests } = setup([
      xml('stock-available-single.xml'),
      xml('stock-available-single.xml'),
    ]);

    await adapter.setStock({ id: '34', sku: Sku.of('DESK-001'), quantity: 10 }, 25);

    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /api/stock_availables/34',
      'PUT /api/stock_availables/34',
    ]);
    expect(requests[1]?.body).toContain('<quantity>25</quantity>');
  });

  it('rejects a reference that does not carry a numeric stock id', async () => {
    const { adapter, requests } = setup([]);

    await expect(
      adapter.setStock({ id: 'abc', sku: Sku.of('DESK-001'), quantity: 1 }, 2),
    ).rejects.toBeInstanceOf(StoreProtocolError);
    expect(requests).toHaveLength(0);
  });
});
