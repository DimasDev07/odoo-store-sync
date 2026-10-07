import { describe, expect, it } from 'vitest';
import { StoreUnavailableError } from '../../domain/errors.js';
import { Sku } from '../../domain/product.js';
import { InMemoryStore } from './in-memory-store.js';

describe('InMemoryStore', () => {
  it('finds seeded products by sku with their current quantity', async () => {
    const store = new InMemoryStore({ 'A-1': 7 });

    const ref = await store.findProductBySku(Sku.of('A-1'));

    expect(ref).toEqual({ id: 'mem-A-1', sku: Sku.of('A-1'), quantity: 7 });
  });

  it('returns null for unknown skus', async () => {
    expect(await new InMemoryStore().findProductBySku(Sku.of('NOPE'))).toBeNull();
  });

  it('applies and records stock updates', async () => {
    const store = new InMemoryStore({ 'A-1': 7 });
    const ref = await store.findProductBySku(Sku.of('A-1'));

    await store.setStock(ref!, 12);

    expect(store.quantityOf('A-1')).toBe(12);
    expect(store.setStockCalls).toEqual([{ sku: 'A-1', quantity: 12 }]);
  });

  it('can seed or override quantities after construction', async () => {
    const store = new InMemoryStore();
    store.setQuantity('B-2', 3);

    expect(store.quantityOf('B-2')).toBe(3);
    expect(store.quantityOf('missing')).toBeUndefined();
  });

  it('injects a failure for one sku until cleared', async () => {
    const store = new InMemoryStore({ 'A-1': 1 });
    store.failOn('A-1', new StoreUnavailableError('503'));

    await expect(store.findProductBySku(Sku.of('A-1'))).rejects.toThrow('503');

    store.clearFailures();
    expect(await store.findProductBySku(Sku.of('A-1'))).not.toBeNull();
  });
});
