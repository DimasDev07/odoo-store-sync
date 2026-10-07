import type { StorePort, StoreProductRef } from '../../application/ports/store-port.js';
import type { Sku } from '../../domain/product.js';

export class InMemoryStore implements StorePort {
  readonly setStockCalls: { sku: string; quantity: number }[] = [];
  private readonly stock = new Map<string, number>();
  private readonly failures = new Map<string, Error>();

  constructor(initial: Readonly<Record<string, number>> = {}) {
    for (const [sku, quantity] of Object.entries(initial)) {
      this.stock.set(sku, quantity);
    }
  }

  async findProductBySku(sku: Sku): Promise<StoreProductRef | null> {
    this.throwIfFailing(sku.value);
    const quantity = this.stock.get(sku.value);
    return quantity === undefined ? null : { id: `mem-${sku.value}`, sku, quantity };
  }

  async setStock(ref: StoreProductRef, quantity: number): Promise<void> {
    this.throwIfFailing(ref.sku.value);
    this.stock.set(ref.sku.value, quantity);
    this.setStockCalls.push({ sku: ref.sku.value, quantity });
  }

  quantityOf(sku: string): number | undefined {
    return this.stock.get(sku);
  }

  /** Seeds or overrides a quantity without recording it as a sync call. */
  setQuantity(sku: string, quantity: number): void {
    this.stock.set(sku, quantity);
  }

  /** Makes every call for this SKU throw `error` until `clearFailures()`. */
  failOn(sku: string, error: Error): void {
    this.failures.set(sku, error);
  }

  clearFailures(): void {
    this.failures.clear();
  }

  private throwIfFailing(sku: string): void {
    const failure = this.failures.get(sku);
    if (failure) {
      throw failure;
    }
  }
}
