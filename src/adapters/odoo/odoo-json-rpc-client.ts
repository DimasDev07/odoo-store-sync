import { z } from 'zod';
import {
  ErpAuthError,
  ErpProtocolError,
  ErpUnavailableError,
  errorMessage,
  type SyncError,
} from '../../domain/errors.js';

export interface OdooConnection {
  /** Base URL of the Odoo instance, e.g. https://mycompany.odoo.com */
  readonly url: string;
  readonly db: string;
  readonly username: string;
  /** API key (Preferences > Account Security). Used in place of the password. */
  readonly apiKey: string;
}

export interface OdooClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Odoo search domain in prefix notation, e.g. [['type', '!=', 'service']]. */
export type OdooDomain = readonly unknown[];

export interface SearchReadOptions {
  readonly fields: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
  readonly order?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const authenticateResult = z.union([z.number().int().positive(), z.literal(false)]);

/**
 * Minimal client for Odoo's external JSON-RPC API (Odoo 17/18):
 * `POST {url}/jsonrpc` with `common.authenticate` and `object.execute_kw`.
 * No Odoo module is needed on the server side.
 */
export class OdooJsonRpcClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private requestId = 0;
  private uid: Promise<number> | undefined;

  constructor(
    private readonly connection: OdooConnection,
    options: OdooClientOptions = {},
  ) {
    this.baseUrl = connection.url.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Authenticates once and caches the uid. A failed attempt is not cached. */
  authenticate(): Promise<number> {
    if (this.uid === undefined) {
      this.uid = this.login().catch((error: unknown) => {
        this.uid = undefined;
        throw error;
      });
    }
    return this.uid;
  }

  async searchRead<T>(
    model: string,
    domain: OdooDomain,
    options: SearchReadOptions,
    schema: z.ZodType<T>,
  ): Promise<T[]> {
    const uid = await this.authenticate();
    const kwargs = {
      fields: options.fields,
      ...(options.limit !== undefined && { limit: options.limit }),
      ...(options.offset !== undefined && { offset: options.offset }),
      ...(options.order !== undefined && { order: options.order }),
    };
    const result = await this.call('object', 'execute_kw', [
      this.connection.db,
      uid,
      this.connection.apiKey,
      model,
      'search_read',
      [domain],
      kwargs,
    ]);

    const parsed = z.array(schema).safeParse(result);
    if (!parsed.success) {
      throw new ErpProtocolError(
        `Unexpected ${model} records from Odoo: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }

  private async login(): Promise<number> {
    const { db, username, apiKey } = this.connection;
    const result = await this.call('common', 'authenticate', [db, username, apiKey, {}]);
    const parsed = authenticateResult.safeParse(result);
    if (!parsed.success) {
      throw new ErpProtocolError('Odoo returned an unexpected authenticate result');
    }
    if (parsed.data === false) {
      throw new ErpAuthError(
        `Odoo rejected the credentials for ${username} on database ${db}`,
      );
    }
    return parsed.data;
  }

  private async call(service: string, method: string, args: readonly unknown[]): Promise<unknown> {
    this.requestId += 1;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id: this.requestId,
    });

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/jsonrpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new ErpUnavailableError(
        `Could not reach Odoo at ${this.baseUrl}: ${errorMessage(cause)}`,
        { cause },
      );
    }

    if (!response.ok) {
      throw mapHttpStatus(response.status, this.baseUrl);
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (cause) {
      throw new ErpProtocolError('Odoo returned a response that is not JSON', { cause });
    }

    const record = asRecord(envelope);
    if (record === undefined) {
      throw new ErpProtocolError('Odoo returned an unexpected JSON-RPC envelope');
    }
    const rpcError = asRecord(record['error']);
    if (rpcError !== undefined) {
      throw mapRpcError(rpcError);
    }
    if (!('result' in record)) {
      throw new ErpProtocolError('Odoo response has neither a result nor an error');
    }
    return record['result'];
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mapHttpStatus(status: number, baseUrl: string): SyncError {
  if (status === 401 || status === 403) {
    return new ErpAuthError(`Odoo answered HTTP ${status}: not authorized`);
  }
  if (status === 429 || status >= 500) {
    return new ErpUnavailableError(`Odoo answered HTTP ${status}`);
  }
  return new ErpProtocolError(`Odoo answered HTTP ${status} for ${baseUrl}/jsonrpc; check ODOO_URL`);
}

const AUTH_ERROR_NAMES = /AccessDenied|AccessError/;
const TRANSIENT_ERROR_NAMES = /OperationalError|TransactionRollbackError|SerializationFailure|LockNotAvailable/;

function mapRpcError(error: Record<string, unknown>): SyncError {
  const data = asRecord(error['data']);
  const name = typeof data?.['name'] === 'string' ? data['name'] : '';
  const detail =
    typeof data?.['message'] === 'string'
      ? data['message']
      : typeof error['message'] === 'string'
        ? error['message']
        : 'no details';

  if (AUTH_ERROR_NAMES.test(name)) {
    return new ErpAuthError(`Odoo denied access: ${detail}`);
  }
  if (TRANSIENT_ERROR_NAMES.test(name)) {
    return new ErpUnavailableError(`Odoo database is busy (${name}): ${detail}`);
  }
  return new ErpProtocolError(`Odoo error (${name || 'unknown'}): ${detail}`);
}
