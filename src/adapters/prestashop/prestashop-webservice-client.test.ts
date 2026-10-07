import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import {
  StoreAuthError,
  StoreNotFoundError,
  StoreProtocolError,
  StoreUnavailableError,
} from '../../domain/errors.js';
import { createFakeFetch, type FakeResponse } from '../test-support/fake-fetch.js';
import { readFixture } from '../test-support/fixtures.js';
import { PrestaShopWebserviceClient } from './prestashop-webservice-client.js';

const xml = (name: string, status = 200): FakeResponse => ({
  status,
  body: readFixture(import.meta.url, `fixtures/${name}`),
  contentType: 'application/xml',
});

const connection = { url: 'https://shop.example.com', wsKey: 'ws-key-123' };

function clientFor(script: Parameters<typeof createFakeFetch>[0], url = connection.url) {
  const fake = createFakeFetch(script);
  const client = new PrestaShopWebserviceClient({ ...connection, url }, { fetch: fake.fetch });
  return { client, requests: fake.requests };
}

describe('PrestaShopWebserviceClient.findProductsByReference', () => {
  it('filters products by exact reference and asks only for id and reference', async () => {
    const { client, requests } = clientFor([xml('products-found.xml')]);

    const products = await client.findProductsByReference('DESK-001');

    expect(products).toEqual([{ id: 12, reference: 'DESK-001' }]);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe(
      'https://shop.example.com/api/products?filter[reference]=[DESK-001]&display=[id,reference]',
    );
  });

  it('authenticates with the webservice key as the Basic auth username', async () => {
    const { client, requests } = clientFor([xml('products-found.xml')]);

    await client.findProductsByReference('DESK-001');

    const expected = `Basic ${Buffer.from('ws-key-123:').toString('base64')}`;
    expect(requests[0]?.headers['authorization']).toBe(expected);
    expect(requests[0]?.url).not.toContain('ws-key-123');
  });

  it('percent-encodes references so they cannot break out of the filter', async () => {
    const { client, requests } = clientFor([xml('products-empty.xml')]);

    await client.findProductsByReference('A B/1&display=full');

    expect(requests[0]?.url).toBe(
      'https://shop.example.com/api/products?filter[reference]=[A%20B%2F1%26display%3Dfull]&display=[id,reference]',
    );
  });

  it('ignores a trailing slash in the shop url', async () => {
    const { client, requests } = clientFor([xml('products-empty.xml')], 'https://shop.example.com/');

    await client.findProductsByReference('X');

    expect(requests[0]?.url.startsWith('https://shop.example.com/api/products?')).toBe(true);
  });

  it('returns an empty list when nothing matches', async () => {
    const { client } = clientFor([xml('products-empty.xml')]);

    expect(await client.findProductsByReference('NOPE')).toEqual([]);
  });

  it('returns every match so the caller can detect ambiguity', async () => {
    const { client } = clientFor([xml('products-duplicate-reference.xml')]);

    expect(await client.findProductsByReference('DESK-001')).toHaveLength(2);
  });

  it('keeps leading zeros in references (no numeric coercion)', async () => {
    const body = '<prestashop><products><product><id>7</id><reference>00123</reference></product></products></prestashop>';
    const { client } = clientFor([{ body, contentType: 'application/xml' }]);

    expect(await client.findProductsByReference('00123')).toEqual([{ id: 7, reference: '00123' }]);
  });
});

describe('PrestaShopWebserviceClient.findStockAvailables', () => {
  it('reads the stock records of the base product (no combination)', async () => {
    const { client, requests } = clientFor([xml('stock-availables-by-product.xml')]);

    const stocks = await client.findStockAvailables(12);

    expect(stocks).toEqual([{ id: 34, productId: 12, quantity: '10' }]);
    expect(requests[0]?.url).toBe(
      'https://shop.example.com/api/stock_availables?filter[id_product]=[12]&filter[id_product_attribute]=[0]&display=[id,id_product,quantity]',
    );
  });

  it('returns an empty list when the product has no stock record', async () => {
    const { client } = clientFor([xml('stock-availables-empty.xml')]);

    expect(await client.findStockAvailables(12)).toEqual([]);
  });
});

describe('PrestaShopWebserviceClient.setStockQuantity', () => {
  it('reads the full resource, changes only the quantity and PUTs it back', async () => {
    const { client, requests } = clientFor([
      xml('stock-available-single.xml'),
      xml('stock-available-single.xml'),
    ]);

    await client.setStockQuantity(34, 25);

    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET https://shop.example.com/api/stock_availables/34',
      'PUT https://shop.example.com/api/stock_availables/34',
    ]);
    const put = requests[1];
    expect(put?.headers['content-type']).toBe('application/xml');
    expect(put?.headers['authorization']).toBe(requests[0]?.headers['authorization']);

    const parse = (text: string) =>
      new XMLParser({ ignoreAttributes: false, parseTagValue: false, ignoreDeclaration: true }).parse(text);
    const original = parse(readFixture(import.meta.url, 'fixtures/stock-available-single.xml'));
    const sent = parse(put?.body ?? '');
    expect(sent.prestashop.stock_available.quantity).toBe('25');
    // everything else, attributes included, is preserved verbatim
    sent.prestashop.stock_available.quantity = original.prestashop.stock_available.quantity;
    expect(sent).toEqual(original);
    expect(put?.body).toContain('xlink:href="https://shop.example.com/api/products/12"');
  });

  it('sends an XML declaration and the new quantity', async () => {
    const { client, requests } = clientFor([
      xml('stock-available-single.xml'),
      xml('stock-available-single.xml'),
    ]);

    await client.setStockQuantity(34, 0);

    expect(requests[1]?.body?.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(requests[1]?.body).toContain('<quantity>0</quantity>');
  });

  it('refuses to PUT a resource that has no quantity field', async () => {
    const { client, requests } = clientFor([xml('stock-available-no-quantity.xml')]);

    await expect(client.setStockQuantity(34, 5)).rejects.toBeInstanceOf(StoreProtocolError);
    expect(requests).toHaveLength(1);
  });

  it('maps a failing PUT to a typed error', async () => {
    const { client } = clientFor([xml('stock-available-single.xml'), xml('error-server.xml', 500)]);

    await expect(client.setStockQuantity(34, 5)).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});

describe('PrestaShopWebserviceClient error mapping', () => {
  const lookup = (script: FakeResponse) =>
    clientFor([script]).client.findProductsByReference('DESK-001');

  it('maps 401 to StoreAuthError and surfaces the PrestaShop message', async () => {
    const error = await lookup(xml('error-unauthorized.xml', 401)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as Error).message).toContain('Authentication key does not exist');
  });

  it('maps 403 to StoreAuthError', async () => {
    await expect(lookup({ status: 403, body: '' })).rejects.toBeInstanceOf(StoreAuthError);
  });

  it('maps 404 to StoreNotFoundError', async () => {
    await expect(lookup(xml('error-not-found.xml', 404))).rejects.toBeInstanceOf(StoreNotFoundError);
  });

  it.each([500, 502, 503, 429])('maps HTTP %i to a retryable error', async (status) => {
    await expect(lookup({ status, body: 'Bad gateway' })).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
  });

  it('maps other 4xx responses to a permanent protocol error', async () => {
    await expect(lookup({ status: 400, body: '' })).rejects.toBeInstanceOf(StoreProtocolError);
  });

  it('maps network failures to a retryable error and keeps the cause', async () => {
    const cause = new TypeError('fetch failed');

    const error = await lookup({ networkError: cause }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StoreUnavailableError);
    expect((error as Error).cause).toBe(cause);
  });

  it('rejects 200 responses that are not PrestaShop XML', async () => {
    await expect(lookup({ body: '<html><body>Maintenance</body></html>' })).rejects.toBeInstanceOf(
      StoreProtocolError,
    );
  });

  it('never leaks the webservice key in error messages', async () => {
    const error = await lookup({ status: 400, body: 'ws-key-123 is not valid' }).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).not.toContain('ws-key-123');
  });
});
