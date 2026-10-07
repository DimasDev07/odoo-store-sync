import type { Sku } from '../../domain/product.js';

/** Reference to a stock record inside the store. `id` is opaque to the core. */
export interface StoreProductRef {
  readonly id: string;
  readonly sku: Sku;
  /** Quantity currently published by the store. */
  readonly quantity: number;
}

export interface StorePort {
  findProductBySku(sku: Sku): Promise<StoreProductRef | null>;
  setStock(ref: StoreProductRef, quantity: number): Promise<void>;
}
