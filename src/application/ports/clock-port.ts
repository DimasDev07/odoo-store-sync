export interface ClockPort {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}
