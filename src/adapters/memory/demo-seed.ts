import { createStockLevel, type StockLevel } from '../../domain/product.js';

export interface DemoSeed {
  readonly erpLevels: readonly StockLevel[];
  readonly storeStock: Readonly<Record<string, number>>;
}

/**
 * Three SKUs that exercise every interesting outcome:
 *  - DESK-001: ERP has 14, store has 10  -> updated
 *  - CHAIR-002: ERP has 5, store has 5   -> skipped (unchanged)
 *  - LAMP-003: not published in the store -> not found
 */
export function createDemoSeed(): DemoSeed {
  return {
    erpLevels: [
      createStockLevel({ sku: 'DESK-001', quantity: 14, sourceVersion: 'demo-1' }),
      createStockLevel({ sku: 'CHAIR-002', quantity: 5, sourceVersion: 'demo-1' }),
      createStockLevel({ sku: 'LAMP-003', quantity: 9, sourceVersion: 'demo-1' }),
    ],
    storeStock: { 'DESK-001': 10, 'CHAIR-002': 5 },
  };
}
