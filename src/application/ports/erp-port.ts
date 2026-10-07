import type { StockLevel } from '../../domain/product.js';

export interface ErpPort {
  /**
   * Returns the current stock level of every SKU-tagged product.
   * `since` narrows the read to records changed after that instant when the
   * ERP can tell; adapters that cannot must return a full snapshot.
   */
  listStockLevels(since?: Date): Promise<StockLevel[]>;
}
