import { InvalidQuantityError, InvalidSkuError } from './errors.js';

/** Stock keeping unit: the business key shared by the ERP and the store. */
export class Sku {
  private constructor(readonly value: string) {}

  static of(raw: string): Sku {
    const value = raw.trim();
    if (value.length === 0) {
      throw new InvalidSkuError('SKU must not be empty');
    }
    return new Sku(value);
  }

  equals(other: Sku): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}

export interface StockLevel {
  readonly sku: Sku;
  /** Units on hand. Always a non-negative integer. */
  readonly quantity: number;
  readonly warehouseId?: string;
  /**
   * Opaque marker of the ERP-side revision this quantity was read at
   * (for Odoo, the record's write_date). It feeds the idempotency key.
   */
  readonly sourceVersion?: string;
}

export interface StockLevelInput {
  sku: Sku | string;
  quantity: number;
  warehouseId?: string | undefined;
  sourceVersion?: string | undefined;
}

export function createStockLevel(input: StockLevelInput): StockLevel {
  if (!Number.isInteger(input.quantity) || input.quantity < 0) {
    throw new InvalidQuantityError(
      `Stock quantity must be a non-negative integer, received ${input.quantity}`,
    );
  }
  const sku = typeof input.sku === 'string' ? Sku.of(input.sku) : input.sku;
  return {
    sku,
    quantity: input.quantity,
    ...(input.warehouseId !== undefined && { warehouseId: input.warehouseId }),
    ...(input.sourceVersion !== undefined && { sourceVersion: input.sourceVersion }),
  };
}
