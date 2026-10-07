import type { ClockPort } from '../application/ports/clock-port.js';

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }

  sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
