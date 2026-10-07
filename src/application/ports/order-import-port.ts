import type { Sku } from '../../domain/product.js';

/*
 * TODO(orders): order import (store -> ERP) is not implemented yet.
 *
 * Planned flow: poll the store for paid orders, map customers and lines by
 * SKU, and create a sales order in the ERP through the same idempotent queue
 * as the stock sync (key = store order id + store order revision). Fiscal
 * positions and the Spanish "recargo de equivalencia" would be resolved in the
 * ERP adapter.
 */

export interface StoreOrderLine {
  readonly sku: Sku;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface StoreOrder {
  readonly storeOrderId: string;
  readonly placedAt: Date;
  readonly customerEmail: string;
  readonly lines: readonly StoreOrderLine[];
}

/** To be implemented by store adapters. */
export interface OrderSourcePort {
  listPaidOrders(since: Date): Promise<StoreOrder[]>;
}

/** To be implemented by ERP adapters. Returns the ERP-side order reference. */
export interface OrderSinkPort {
  createSalesOrder(order: StoreOrder): Promise<string>;
}
