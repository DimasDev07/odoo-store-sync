import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import {
  errorMessage,
  StoreAuthError,
  StoreNotFoundError,
  StoreProtocolError,
  StoreUnavailableError,
  type SyncError,
} from '../../domain/errors.js';

export interface PrestaShopConnection {
  /** Base URL of the shop, e.g. https://shop.example.com */
  readonly url: string;
  /** Webservice key (Advanced Parameters > Webservice). */
  readonly wsKey: string;
}

export interface PrestaShopClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface PrestaShopProduct {
  readonly id: number;
  readonly reference: string;
}

export interface PrestaShopStockAvailable {
  readonly id: number;
  readonly productId: number;
  /** Raw text from the webservice; the adapter validates it. */
  readonly quantity: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

// Every value stays a string: references such as "00123" must not become numbers.
const xmlOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  ignoreDeclaration: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name: string) => name === 'product' || name === 'stock_available' || name === 'error',
} as const;
const parser = new XMLParser(xmlOptions);
const builder = new XMLBuilder({ ...xmlOptions, format: false });

// An empty collection (`<products></products>`) parses to an empty string.
const productsDocument = z.object({
  prestashop: z.object({
    products: z.union([
      z.literal(''),
      z.object({ product: z.array(z.object({ id: z.string(), reference: z.string() })) }),
    ]),
  }),
});
const stockAvailablesDocument = z.object({
  prestashop: z.object({
    stock_availables: z.union([
      z.literal(''),
      z.object({
        stock_available: z.array(
          z.object({ id: z.string(), id_product: z.string(), quantity: z.string() }),
        ),
      }),
    ]),
  }),
});
const stockAvailableDocument = z
  .object({
    prestashop: z
      .object({ stock_available: z.array(z.record(z.string(), z.unknown())).min(1) })
      .loose(),
  })
  .loose();

/**
 * Minimal client for the PrestaShop 1.7/8 webservice.
 * Authentication: the webservice key is the Basic auth username, password empty.
 */
export class PrestaShopWebserviceClient {
  private readonly apiUrl: string;
  private readonly authorization: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly connection: PrestaShopConnection,
    options: PrestaShopClientOptions = {},
  ) {
    this.apiUrl = `${connection.url.replace(/\/+$/, '')}/api`;
    this.authorization = `Basic ${Buffer.from(`${connection.wsKey}:`).toString('base64')}`;
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async findProductsByReference(reference: string): Promise<PrestaShopProduct[]> {
    const body = await this.request(
      'GET',
      `/products?filter[reference]=[${encodeURIComponent(reference)}]&display=[id,reference]`,
    );
    const document = this.parse(productsDocument, body, 'products');
    const products = document.prestashop.products;
    return products === ''
      ? []
      : products.product.map((p) => ({ id: toId(p.id), reference: p.reference }));
  }

  /** Stock records of the base product (combinations are not synchronized yet). */
  async findStockAvailables(productId: number): Promise<PrestaShopStockAvailable[]> {
    const body = await this.request(
      'GET',
      `/stock_availables?filter[id_product]=[${productId}]&filter[id_product_attribute]=[0]&display=[id,id_product,quantity]`,
    );
    const document = this.parse(stockAvailablesDocument, body, 'stock_availables');
    const stocks = document.prestashop.stock_availables;
    return stocks === ''
      ? []
      : stocks.stock_available.map((s) => ({
          id: toId(s.id),
          productId: toId(s.id_product),
          quantity: s.quantity,
        }));
  }

  /**
   * PrestaShop PUT replaces the whole resource, so the current representation
   * is fetched first and sent back with only `quantity` changed.
   */
  async setStockQuantity(stockAvailableId: number, quantity: number): Promise<void> {
    const path = `/stock_availables/${stockAvailableId}`;
    const current = await this.request('GET', path);
    const document = this.parse(stockAvailableDocument, current, `stock_available ${stockAvailableId}`);
    const resource = document.prestashop.stock_available[0];
    if (resource === undefined || !('quantity' in resource)) {
      throw new StoreProtocolError(
        `stock_available ${stockAvailableId} has no quantity field; refusing to overwrite it`,
      );
    }
    resource['quantity'] = String(quantity);
    await this.request('PUT', path, XML_DECLARATION + builder.build(document));
  }

  private async request(method: 'GET' | 'PUT', path: string, body?: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.apiUrl}${path}`, {
        method,
        headers: {
          authorization: this.authorization,
          accept: 'application/xml',
          ...(body !== undefined && { 'content-type': 'application/xml' }),
        },
        ...(body !== undefined && { body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new StoreUnavailableError(
        `Could not reach PrestaShop at ${this.apiUrl}: ${errorMessage(cause)}`,
        { cause },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw this.mapStatus(response.status, text);
    }
    return text;
  }

  private parse<T>(schema: z.ZodType<T>, body: string, what: string): T {
    let raw: unknown;
    try {
      raw = parser.parse(body);
    } catch (cause) {
      throw new StoreProtocolError(`PrestaShop returned unreadable XML for ${what}`, { cause });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new StoreProtocolError(`Unexpected PrestaShop response for ${what}`);
    }
    return parsed.data;
  }

  private mapStatus(status: number, body: string): SyncError {
    const detail = this.extractErrorMessage(body);
    const suffix = detail === undefined ? '' : `: ${detail}`;
    if (status === 401 || status === 403) {
      return new StoreAuthError(`PrestaShop answered HTTP ${status}${suffix}`);
    }
    if (status === 404) {
      return new StoreNotFoundError(`PrestaShop answered HTTP 404${suffix}`);
    }
    if (status === 429 || status >= 500) {
      return new StoreUnavailableError(`PrestaShop answered HTTP ${status}${suffix}`);
    }
    return new StoreProtocolError(`PrestaShop answered HTTP ${status}${suffix}`);
  }

  private extractErrorMessage(body: string): string | undefined {
    try {
      const parsed = z
        .object({
          prestashop: z.object({ errors: z.object({ error: z.array(z.object({ message: z.string() })) }) }),
        })
        .safeParse(parser.parse(body));
      const message = parsed.success ? parsed.data.prestashop.errors.error[0]?.message : undefined;
      return message?.replaceAll(this.connection.wsKey, '***');
    } catch {
      return undefined;
    }
  }
}

function toId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new StoreProtocolError(`PrestaShop returned an invalid id: ${value}`);
  }
  return id;
}
