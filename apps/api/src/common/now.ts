/**
 * Injectable current time (milliseconds since the epoch), so reminders, sync schedules and
 * their tests agree on "now". Production uses the system clock.
 */
export type Now = () => number;
export const NOW = Symbol('NOW');
export const systemNow: Now = () => Date.now();
