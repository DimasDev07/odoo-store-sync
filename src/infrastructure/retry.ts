import type { ClockPort } from '../application/ports/clock-port.js';
import type { RetryRunner } from '../application/ports/job-queue-port.js';
import { isRetryable } from '../domain/errors.js';

export interface RetryInfo {
  /** The attempt that just failed (1-based). */
  readonly attempt: number;
  /** How long the runner will wait before the next attempt. */
  readonly delayMs: number;
  readonly error: unknown;
}

export interface RetryOptions {
  /** Total attempts, including the first one. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly clock: Pick<ClockPort, 'sleep'>;
  /** Returns a number in [0, 1]. Injectable for deterministic tests. */
  readonly random?: () => number;
  /** Defaults to the domain rule: only transient SyncErrors are retried. */
  readonly isRetryable?: (error: unknown) => boolean;
  readonly onRetry?: (info: RetryInfo) => void;
}

/**
 * Exponential backoff with full jitter: a random delay between zero and
 * `min(maxDelayMs, baseDelayMs * 2^(attempt - 1))`. Jitter keeps many failing
 * jobs from hitting a recovering server at the same instant.
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export function createRetryRunner(options: RetryOptions): RetryRunner {
  const { maxAttempts, baseDelayMs, maxDelayMs, clock, onRetry } = options;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be an integer >= 1');
  }
  if (baseDelayMs < 0 || maxDelayMs < baseDelayMs) {
    throw new RangeError('delays must satisfy 0 <= baseDelayMs <= maxDelayMs');
  }
  const random = options.random ?? Math.random;
  const canRetry = options.isRetryable ?? isRetryable;

  return async <T>(operation: (attempt: number) => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation(attempt);
      } catch (error) {
        if (attempt >= maxAttempts || !canRetry(error)) {
          throw error;
        }
        const delayMs = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs, random);
        onRetry?.({ attempt, delayMs, error });
        await clock.sleep(delayMs);
      }
    }
  };
}
