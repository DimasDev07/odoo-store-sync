import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemClock } from './system-clock.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('SystemClock', () => {
  it('reports the current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));

    expect(new SystemClock().now().toISOString()).toBe('2026-10-08T10:00:00.000Z');
  });

  it('sleeps for the requested time', async () => {
    vi.useFakeTimers();
    let woke = false;

    const sleeping = new SystemClock().sleep(1_000).then(() => {
      woke = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;

    expect(woke).toBe(true);
  });
});
