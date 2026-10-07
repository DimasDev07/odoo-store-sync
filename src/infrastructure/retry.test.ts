import { describe, expect, it } from 'vitest';
import { FakeClock } from '../adapters/memory/fake-clock.js';
import { InMemoryJobQueue } from '../adapters/memory/in-memory-job-queue.js';
import { StoreAuthError, StoreUnavailableError } from '../domain/errors.js';
import { computeBackoffDelay, createRetryRunner, type RetryOptions } from './retry.js';

const START = new Date('2026-10-08T10:00:00.000Z');

function runner(overrides: Partial<RetryOptions> = {}) {
  const clock = new FakeClock(START);
  const run = createRetryRunner({
    maxAttempts: 4,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    clock,
    random: () => 1,
    ...overrides,
  });
  return { run, clock };
}

/** Fails with `error` for the first `failures` attempts, then returns "ok". */
function flaky(failures: number, error: Error = new StoreUnavailableError('503')) {
  const attempts: number[] = [];
  const operation = async (attempt: number) => {
    attempts.push(attempt);
    if (attempt <= failures) throw error;
    return 'ok';
  };
  return { operation, attempts };
}

describe('computeBackoffDelay', () => {
  it('doubles the ceiling on every attempt', () => {
    const delays = [1, 2, 3, 4].map((attempt) => computeBackoffDelay(attempt, 100, 10_000, () => 1));

    expect(delays).toEqual([100, 200, 400, 800]);
  });

  it('never exceeds the cap', () => {
    expect(computeBackoffDelay(10, 100, 1_000, () => 1)).toBe(1_000);
  });

  it('applies full jitter between zero and the ceiling', () => {
    expect(computeBackoffDelay(3, 100, 10_000, () => 0)).toBe(0);
    expect(computeBackoffDelay(3, 100, 10_000, () => 0.5)).toBe(200);
  });

  it('returns whole milliseconds', () => {
    expect(Number.isInteger(computeBackoffDelay(1, 100, 1_000, () => 0.333))).toBe(true);
  });
});

describe('createRetryRunner', () => {
  it('returns the result without sleeping when the first attempt works', async () => {
    const { run, clock } = runner();
    const { operation, attempts } = flaky(0);

    expect(await run(operation)).toBe('ok');
    expect(attempts).toEqual([1]);
    expect(clock.sleeps).toEqual([]);
  });

  it('retries transient errors with exponential backoff on the injected clock', async () => {
    const { run, clock } = runner();
    const { operation, attempts } = flaky(3);

    expect(await run(operation)).toBe('ok');
    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(clock.sleeps).toEqual([100, 200, 400]);
    expect(clock.now().getTime() - START.getTime()).toBe(700);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const { run, clock } = runner({ maxAttempts: 3 });
    const { operation, attempts } = flaky(10);

    await expect(run(operation)).rejects.toThrow('503');
    expect(attempts).toEqual([1, 2, 3]);
    expect(clock.sleeps).toHaveLength(2);
  });

  it('does not retry permanent errors', async () => {
    const { run, clock } = runner();
    const { operation, attempts } = flaky(10, new StoreAuthError('401'));

    await expect(run(operation)).rejects.toThrow('401');
    expect(attempts).toEqual([1]);
    expect(clock.sleeps).toEqual([]);
  });

  it('accepts a custom retryability rule', async () => {
    const { run } = runner({ isRetryable: () => true });
    const { operation, attempts } = flaky(1, new Error('anything'));

    expect(await run(operation)).toBe('ok');
    expect(attempts).toEqual([1, 2]);
  });

  it('reports each scheduled retry', async () => {
    const seen: { attempt: number; delayMs: number; message: string }[] = [];
    const { run } = runner({
      onRetry: ({ attempt, delayMs, error }) =>
        seen.push({ attempt, delayMs, message: (error as Error).message }),
    });

    await run(flaky(2).operation);

    expect(seen).toEqual([
      { attempt: 1, delayMs: 100, message: '503' },
      { attempt: 2, delayMs: 200, message: '503' },
    ]);
  });

  it('uses Math.random for jitter by default', async () => {
    const clock = new FakeClock(START);
    const run = createRetryRunner({ maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 100, clock });

    await run(flaky(1).operation);

    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(0);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(100);
  });

  it.each([
    { maxAttempts: 0 },
    { maxAttempts: 1.5 },
    { baseDelayMs: -1 },
    { maxDelayMs: 50 },
  ])('rejects invalid options %j', (overrides) => {
    expect(() => runner(overrides)).toThrow(RangeError);
  });
});

describe('as the retry policy of the job queue', () => {
  it('retries a flaky job with backoff and then succeeds', async () => {
    const { run, clock } = runner();
    const queue = new InMemoryJobQueue<string>({ retry: run });
    await queue.enqueue({ idempotencyKey: 'a', payload: 'a' });
    const { operation } = flaky(2);

    const summary = await queue.process((_job, attempt) => operation(attempt).then(() => undefined));

    expect(summary).toEqual({ succeeded: 1, failed: [] });
    expect(clock.sleeps).toEqual([100, 200]);
  });
});
