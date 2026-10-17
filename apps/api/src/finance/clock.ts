/** Injectable "today", so reports, rate lookups and tests agree on the date. UTC calendar date. */
export interface Clock {
  today(): string;
}

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = {
  today: () => new Date().toISOString().slice(0, 10),
};
