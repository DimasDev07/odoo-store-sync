import type { StorePort, StoreProductRef } from '../../application/ports/store-port.js';
import { StoreProtocolError } from '../../domain/errors.js';
import type { Sku } from '../../domain/product.js';
import type { PrestaShopWebserviceClient } from './prestashop-webservice-client.js';

/**
 * StorePort over the PrestaShop webservice. `StoreProductRef.id` carries the
 * `stock_available` id, which is what a stock update needs.
 *
 * Out of scope for now: product combinations (attributes) and multistore.
 */
export class PrestaShopStoreAdapter implements StorePort {
  constructor(private readonly client: PrestaShopWebserviceClient) {}

  async findProductBySku(sku: Sku): Promise<StoreProductRef | null> {
    const products = await this.client.findProductsByReference(sku.value);
    const [product] = products;
    if (product === undefined) {
      return null;
    }
    if (products.length > 1) {
      throw new StoreProtocolError(
        `${products.length} products share reference ${sku.value}; refusing to guess which one to update`,
      );
    }

    const stocks = await this.client.findStockAvailables(product.id);
    const [stock] = stocks;
    if (stock === undefined) {
      throw new StoreProtocolError(`Product ${product.id} (${sku.value}) has no stock_available record`);
    }
    if (stocks.length > 1) {
      throw new StoreProtocolError(
        `Product ${product.id} (${sku.value}) has ${stocks.length} stock records; multistore is not supported yet`,
      );
    }
    if (!/^-?\d+$/.test(stock.quantity)) {
      throw new StoreProtocolError(
        `Product ${product.id} (${sku.value}) reports a non-integer quantity: ${stock.quantity}`,
      );
    }
    return { id: String(stock.id), sku, quantity: Number(stock.quantity) };
  }

  async setStock(ref: StoreProductRef, quantity: number): Promise<void> {
    const stockAvailableId = Number(ref.id);
    if (!Number.isInteger(stockAvailableId) || stockAvailableId <= 0) {
      throw new StoreProtocolError(`Not a PrestaShop stock_available id: ${ref.id}`);
    }
    await this.client.setStockQuantity(stockAvailableId, quantity);
  }
}
