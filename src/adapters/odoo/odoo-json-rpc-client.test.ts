import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ErpAuthError,
  ErpProtocolError,
  ErpUnavailableError,
} from '../../domain/errors.js';
import { createFakeFetch, type FakeResponse } from '../test-support/fake-fetch.js';
import { readFixture } from '../test-support/fixtures.js';
import { OdooJsonRpcClient } from './odoo-json-rpc-client.js';

const fixture = (name: string): FakeResponse => ({
  body: readFixture(import.meta.url, `fixtures/${name}`),
});

const connection = {
  url: 'https://erp.example.com',
  db: 'prod',
  username: 'sync@example.com',
  apiKey: 'secret-key',
};

const productSchema = z.object({ id: z.number(), default_code: z.union([z.string(), z.literal(false)]) });

function clientFor(script: Parameters<typeof createFakeFetch>[0], overrides = connection) {
  const fake = createFakeFetch(script);
  return { client: new OdooJsonRpcClient(overrides, { fetch: fake.fetch }), requests: fake.requests };
}

describe('OdooJsonRpcClient.authenticate', () => {
  it('posts a common.authenticate call to /jsonrpc and returns the uid', async () => {
    const { client, requests } = clientFor([fixture('authenticate-ok.json')]);

    expect(await client.authenticate()).toBe(7);

    const [request] = requests;
    expect(request?.url).toBe('https://erp.example.com/jsonrpc');
    expect(request?.method).toBe('POST');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.json()).toEqual({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'common',
        method: 'authenticate',
        args: ['prod', 'sync@example.com', 'secret-key', {}],
      },
      id: 1,
    });
  });

  it('ignores a trailing slash in the base url', async () => {
    const { client, requests } = clientFor([fixture('authenticate-ok.json')], {
      ...connection,
      url: 'https://erp.example.com/',
    });

    await client.authenticate();

    expect(requests[0]?.url).toBe('https://erp.example.com/jsonrpc');
  });

  it('rejects credentials that Odoo refuses', async () => {
    const { client } = clientFor([fixture('authenticate-rejected.json')]);

    await expect(client.authenticate()).rejects.toBeInstanceOf(ErpAuthError);
  });

  it('reuses the uid across calls', async () => {
    const { client, requests } = clientFor([
      fixture('authenticate-ok.json'),
      fixture('empty-result.json'),
      fixture('empty-result.json'),
    ]);

    await client.searchRead('product.product', [], { fields: ['id'] }, productSchema);
    await client.searchRead('product.product', [], { fields: ['id'] }, productSchema);

    expect(requests.map((r) => r.json().params.service)).toEqual(['common', 'object', 'object']);
  });

  it('authenticates once when calls overlap', async () => {
    const { client, requests } = clientFor([
      fixture('authenticate-ok.json'),
      fixture('empty-result.json'),
      fixture('empty-result.json'),
    ]);

    await Promise.all([
      client.searchRead('product.product', [], { fields: ['id'] }, productSchema),
      client.searchRead('product.product', [], { fields: ['id'] }, productSchema),
    ]);

    expect(requests.filter((r) => r.json().params.service === 'common')).toHaveLength(1);
  });

  it('retries authentication on the next call after a failure', async () => {
    const { client } = clientFor([
      fixture('authenticate-rejected.json'),
      fixture('authenticate-ok.json'),
    ]);

    await expect(client.authenticate()).rejects.toBeInstanceOf(ErpAuthError);
    expect(await client.authenticate()).toBe(7);
  });
});

describe('OdooJsonRpcClient.searchRead', () => {
  it('sends execute_kw with uid, api key, domain and keyword arguments', async () => {
    const { client, requests } = clientFor([
      fixture('authenticate-ok.json'),
      fixture('products-page-1.json'),
    ]);

    const records = await client.searchRead(
      'product.product',
      [['type', '!=', 'service']],
      { fields: ['default_code'], limit: 3, offset: 6, order: 'id' },
      z.object({ id: z.number(), default_code: z.string() }),
    );

    expect(records.map((r) => r.default_code)).toEqual(['DESK-001', 'CHAIR-002', 'LAMP-003']);
    expect(requests[1]?.json()).toEqual({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [
          'prod',
          7,
          'secret-key',
          'product.product',
          'search_read',
          [[['type', '!=', 'service']]],
          { fields: ['default_code'], limit: 3, offset: 6, order: 'id' },
        ],
      },
      id: 2,
    });
  });

  it('omits optional keyword arguments that were not given', async () => {
    const { client, requests } = clientFor([
      fixture('authenticate-ok.json'),
      fixture('empty-result.json'),
    ]);

    await client.searchRead('product.product', [], { fields: ['id'] }, productSchema);

    expect(requests[1]?.json().params.args[6]).toEqual({ fields: ['id'] });
  });

  it('fails with a protocol error when a record does not match the schema', async () => {
    const { client } = clientFor([
      fixture('authenticate-ok.json'),
      fixture('products-malformed.json'),
    ]);

    await expect(
      client.searchRead(
        'product.product',
        [],
        { fields: ['qty_available'] },
        z.object({ qty_available: z.number() }),
      ),
    ).rejects.toThrow(ErpProtocolError);
  });
});

describe('OdooJsonRpcClient error mapping', () => {
  const rpcCall = (script: FakeResponse) => {
    const { client } = clientFor([fixture('authenticate-ok.json'), script]);
    return client.searchRead('product.product', [], { fields: ['id'] }, productSchema);
  };

  it('maps AccessDenied to ErpAuthError', async () => {
    await expect(rpcCall(fixture('error-access-denied.json'))).rejects.toBeInstanceOf(ErpAuthError);
  });

  it('maps business errors to a permanent protocol error carrying the Odoo message', async () => {
    const error = await rpcCall(fixture('error-user-error.json')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErpProtocolError);
    expect((error as Error).message).toContain("Invalid field 'qty_on_hand'");
  });

  it('maps database contention to a retryable error', async () => {
    await expect(rpcCall(fixture('error-database-busy.json'))).rejects.toBeInstanceOf(
      ErpUnavailableError,
    );
  });

  it.each([500, 502, 503, 429])('maps HTTP %i to a retryable error', async (status) => {
    await expect(rpcCall({ status, body: 'upstream trouble' })).rejects.toBeInstanceOf(
      ErpUnavailableError,
    );
  });

  it.each([401, 403])('maps HTTP %i to ErpAuthError', async (status) => {
    await expect(rpcCall({ status, body: '' })).rejects.toBeInstanceOf(ErpAuthError);
  });

  it.each([400, 404])('maps HTTP %i to a permanent protocol error', async (status) => {
    await expect(rpcCall({ status, body: '' })).rejects.toBeInstanceOf(ErpProtocolError);
  });

  it('maps network failures to a retryable error and keeps the cause', async () => {
    const cause = new TypeError('fetch failed');

    const error = await rpcCall({ networkError: cause }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErpUnavailableError);
    expect((error as Error).cause).toBe(cause);
  });

  it('rejects responses that are not JSON', async () => {
    await expect(rpcCall({ body: '<html>maintenance</html>' })).rejects.toThrow(ErpProtocolError);
  });

  it('rejects JSON-RPC envelopes without a result', async () => {
    await expect(rpcCall({ body: '{"jsonrpc":"2.0","id":2}' })).rejects.toThrow(ErpProtocolError);
  });

  it('falls back to the generic message when an error has no data', async () => {
    const error = await rpcCall({
      body: '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErpProtocolError);
    expect((error as Error).message).toContain('Method not found');
  });

  it('rejects an authenticate result that is neither a uid nor false', async () => {
    const { client } = clientFor([{ body: '{"jsonrpc":"2.0","id":1,"result":"7"}' }]);

    await expect(client.authenticate()).rejects.toThrow(ErpProtocolError);
  });
});
