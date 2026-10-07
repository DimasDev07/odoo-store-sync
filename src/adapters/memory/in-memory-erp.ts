import type { ErpPort } from '../../application/ports/erp-port.js';
import type { StockLevel } from '../../domain/product.js';

export class InMemoryErp implements ErpPort {
  readonly sinceArgs: (Date | undefined)[] = [];
  private levels: StockLevel[];
  private failure: Error | undefined;

  constructor(levels: readonly StockLevel[] = []) {
    this.levels = [...levels];
  }

  async listStockLevels(since?: Date): Promise<StockLevel[]> {
    this.sinceArgs.push(since);
    if (this.failure) {
      throw this.failure;
    }
    return [...this.levels];
  }

  setLevels(levels: readonly StockLevel[]): void {
    this.levels = [...levels];
  }

  /** Makes every read throw `error`; pass `undefined` to recover. */
  failWith(error: Error | undefined): void {
    this.failure = error;
  }
}
