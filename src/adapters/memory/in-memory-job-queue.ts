import type {
  EnqueueResult,
  FailedJob,
  Job,
  JobHandler,
  JobQueuePort,
  QueueRunSummary,
  RetryRunner,
} from '../../application/ports/job-queue-port.js';

export interface InMemoryJobQueueOptions {
  /** Retry policy applied around each job. Defaults to a single attempt. */
  readonly retry?: RetryRunner;
}

const singleAttempt: RetryRunner = (operation) => operation(1);

/**
 * Process-local FIFO queue. Accepted idempotency keys are remembered for the
 * lifetime of the instance; a durable queue (Postgres, Redis) is on the roadmap.
 */
export class InMemoryJobQueue<TPayload> implements JobQueuePort<TPayload> {
  private readonly acceptedKeys = new Set<string>();
  private readonly pending: Job<TPayload>[] = [];
  private readonly retry: RetryRunner;

  constructor(options: InMemoryJobQueueOptions = {}) {
    this.retry = options.retry ?? singleAttempt;
  }

  async enqueue(job: Job<TPayload>): Promise<EnqueueResult> {
    if (this.acceptedKeys.has(job.idempotencyKey)) {
      return 'duplicate';
    }
    this.acceptedKeys.add(job.idempotencyKey);
    this.pending.push(job);
    return 'enqueued';
  }

  async process(handler: JobHandler<TPayload>): Promise<QueueRunSummary<TPayload>> {
    let succeeded = 0;
    const failed: FailedJob<TPayload>[] = [];

    for (let job = this.pending.shift(); job !== undefined; job = this.pending.shift()) {
      let attempts = 0;
      try {
        const current = job;
        await this.retry(async (attempt) => {
          attempts = attempt;
          await handler(current, attempt);
        });
        succeeded += 1;
      } catch (error) {
        this.acceptedKeys.delete(job.idempotencyKey);
        failed.push({ job, attempts, error });
      }
    }

    return { succeeded, failed };
  }
}
