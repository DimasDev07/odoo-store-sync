import { z } from 'zod';
import type { ErpPort } from '../../application/ports/erp-port.js';
import type { LoggerPort } from '../../application/ports/logger-port.js';
import { InvalidSkuError } from '../../domain/errors.js';
import { createStockLevel, type StockLevel } from '../../domain/product.js';
import type { OdooDomain, OdooJsonRpcClient } from './odoo-json-rpc-client.js';

export interface OdooErpAdapterOptions {
  /**
   * When set, stock is read from `stock.quant` (internal locations of these
   * warehouses) instead of `product.product.qty_available`. Quantities are
   * summed across the listed warehouses.
   */
  readonly warehouseIds?: readonly number[];
  /** Extra filter for product.product. Default excludes services. */
  readonly productDomain?: OdooDomain;
  readonly pageSize?: number;
  readonly productLookupChunkSize?: number;
}

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_LOOKUP_CHUNK_SIZE = 200;
const DEFAULT_PRODUCT_DOMAIN: OdooDomain = [['type', '!=', 'service']];

/** Odoo sends `false` instead of null for empty fields. */
const optionalText = z.union([z.string(), z.literal(false), z.null()]);

const productRecord = z.object({
  id: z.number(),
  default_code: optionalText,
  qty_available: z.number(),
  write_date: optionalText,
});

const quantRecord = z.object({
  product_id: z.tuple([z.number(), z.string()]),
  quantity: z.number(),
  write_date: optionalText,
});

const productCodeRecord = z.object({ id: z.number(), default_code: optionalText });

/**
 * ErpPort over Odoo's external JSON-RPC API.
 *
 * It always returns a full snapshot: `since` is ignored because Odoo does not
 * update product.write_date on stock moves, so there is no cheap, reliable
 * incremental signal. Incremental reads via stock.move are on the roadmap.
 */
export class OdooErpAdapter implements ErpPort {
  private readonly pageSize: number;
  private readonly lookupChunkSize: number;
  private readonly productDomain: OdooDomain;
  private readonly warehouseIds: readonly number[];

  constructor(
    private readonly client: OdooJsonRpcClient,
    private readonly logger: LoggerPort,
    options: OdooErpAdapterOptions = {},
  ) {
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.lookupChunkSize = options.productLookupChunkSize ?? DEFAULT_LOOKUP_CHUNK_SIZE;
    this.productDomain = options.productDomain ?? DEFAULT_PRODUCT_DOMAIN;
    this.warehouseIds = options.warehouseIds ?? [];
  }

  async listStockLevels(_since?: Date): Promise<StockLevel[]> {
    const skipped: number[] = [];
    const levels =
      this.warehouseIds.length > 0
        ? await this.readFromQuants(skipped)
        : await this.readFromProducts(skipped);

    if (skipped.length > 0) {
      this.logger.warn('Skipped Odoo products without a usable default_code', {
        count: skipped.length,
        productIds: skipped,
      });
    }
    return levels;
  }

  private async readFromProducts(skipped: number[]): Promise<StockLevel[]> {
    const records = await this.readAllPages('product.product', this.productDomain, {
      fields: ['default_code', 'qty_available', 'write_date'],
      schema: productRecord,
    });

    const levels: StockLevel[] = [];
    for (const record of records) {
      const level = toStockLevel(record.default_code, record.qty_available, record.write_date);
      if (level === undefined) {
        skipped.push(record.id);
      } else {
        levels.push(level);
      }
    }
    return levels;
  }

  private async readFromQuants(skipped: number[]): Promise<StockLevel[]> {
    const quants = await this.readAllPages(
      'stock.quant',
      [
        ['warehouse_id', 'in', this.warehouseIds],
        ['location_id.usage', '=', 'internal'],
      ],
      { fields: ['product_id', 'quantity', 'write_date'], schema: quantRecord },
    );

    const totals = new Map<number, { quantity: number; version: string | undefined }>();
    for (const quant of quants) {
      const productId = quant.product_id[0];
      const version = typeof quant.write_date === 'string' ? quant.write_date : undefined;
      const total = totals.get(productId) ?? { quantity: 0, version: undefined };
      total.quantity += quant.quantity;
      if (version !== undefined && (total.version === undefined || version > total.version)) {
        total.version = version;
      }
      totals.set(productId, total);
    }

    const codes = await this.lookupProductCodes([...totals.keys()]);
    const warehouseId = this.warehouseIds.length === 1 ? String(this.warehouseIds[0]) : undefined;

    const levels: StockLevel[] = [];
    for (const [productId, total] of totals) {
      const level = toStockLevel(codes.get(productId), total.quantity, total.version, warehouseId);
      if (level === undefined) {
        skipped.push(productId);
      } else {
        levels.push(level);
      }
    }
    return levels;
  }

  private async lookupProductCodes(productIds: readonly number[]): Promise<Map<number, string>> {
    const codes = new Map<number, string>();
    for (let start = 0; start < productIds.length; start += this.lookupChunkSize) {
      const chunk = productIds.slice(start, start + this.lookupChunkSize);
      const records = await this.client.searchRead(
        'product.product',
        [['id', 'in', chunk]],
        { fields: ['default_code'] },
        productCodeRecord,
      );
      for (const record of records) {
        if (typeof record.default_code === 'string') {
          codes.set(record.id, record.default_code);
        }
      }
    }
    return codes;
  }

  private async readAllPages<T>(
    model: string,
    domain: OdooDomain,
    query: { fields: readonly string[]; schema: z.ZodType<T> },
  ): Promise<T[]> {
    const all: T[] = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const page = await this.client.searchRead(
        model,
        domain,
        { fields: query.fields, limit: this.pageSize, offset, order: 'id' },
        query.schema,
      );
      all.push(...page);
      if (page.length < this.pageSize) {
        return all;
      }
    }
  }
}

/**
 * Returns undefined when the product has no usable SKU. Quantities are
 * normalized for the store: Odoo allows negative and fractional on-hand
 * values, a shop publishes a non-negative whole number of units.
 */
function toStockLevel(
  code: string | false | null | undefined,
  quantity: number,
  version: string | false | null | undefined,
  warehouseId?: string,
): StockLevel | undefined {
  if (typeof code !== 'string') {
    return undefined;
  }
  try {
    return createStockLevel({
      sku: code,
      quantity: Math.max(0, Math.floor(quantity)),
      warehouseId,
      sourceVersion: typeof version === 'string' ? version : undefined,
    });
  } catch (error) {
    if (error instanceof InvalidSkuError) {
      return undefined;
    }
    throw error;
  }
}
