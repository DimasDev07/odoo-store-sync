import { describe, expect, it } from 'vitest';
import { FakeClock } from './fake-clock.js';

describe('FakeClock', () => {
  it('starts at the given instant', () => {
    expect(new FakeClock(new Date('2026-01-01T00:00:00Z')).now().toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('sleep advances time instantly and records the delay', async () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));

    await clock.sleep(1500);
    await clock.sleep(500);

    expect(clock.sleeps).toEqual([1500, 500]);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:02.000Z');
  });

  it('returns a fresh Date each time so callers cannot move the clock', () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));

    clock.now().setFullYear(1999);

    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
