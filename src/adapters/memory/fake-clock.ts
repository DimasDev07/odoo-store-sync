import type { ClockPort } from '../../application/ports/clock-port.js';

/** Deterministic clock: `sleep` does not wait, it only moves time forward. */
export class FakeClock implements ClockPort {
  readonly sleeps: number[] = [];
  private current: number;

  constructor(start: Date) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.current += milliseconds;
  }
}
