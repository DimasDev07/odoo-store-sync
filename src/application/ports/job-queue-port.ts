export interface Job<TPayload> {
  /** Two jobs with the same key are the same unit of work. */
  readonly idempotencyKey: string;
  readonly payload: TPayload;
}

export type EnqueueResult = 'enqueued' | 'duplicate';

/** Receives the 1-based attempt number. Throwing marks the attempt as failed. */
export type JobHandler<TPayload> = (job: Job<TPayload>, attempt: number) => Promise<void>;

export interface FailedJob<TPayload> {
  readonly job: Job<TPayload>;
  readonly attempts: number;
  readonly error: unknown;
}

export interface QueueRunSummary<TPayload> {
  readonly succeeded: number;
  readonly failed: readonly FailedJob<TPayload>[];
}

/**
 * Runs `operation` until it succeeds or the retry policy gives up, in which
 * case the last error is rethrown. The operation receives the attempt number.
 */
export type RetryRunner = <T>(operation: (attempt: number) => Promise<T>) => Promise<T>;

export interface JobQueuePort<TPayload> {
  /**
   * Adds the job unless its key was already accepted. A key is released when
   * its job fails for good, so a later run may enqueue it again.
   */
  enqueue(job: Job<TPayload>): Promise<EnqueueResult>;
  /** Drains the queue, retrying failed jobs according to the queue's own policy. */
  process(handler: JobHandler<TPayload>): Promise<QueueRunSummary<TPayload>>;
}
