// The delay between one failed dial and the next. The agent redials forever — a hub that is down
// for a day must not leave the agent permanently quiet — so the delay grows with each consecutive
// failure but is capped, and it is jittered so that a fleet of agents (or one agent retrying fast)
// does not fall into a lockstep of identical retries. This is a pure function of the attempt number
// and a random source, so it is checked directly.

export interface BackoffOptions {
  /** The base delay, used for the first retry, in milliseconds. */
  baseMs: number;
  /** The ceiling the delay never exceeds, in milliseconds. */
  capMs: number;
  /** How much the raw delay grows per attempt. Two doubles it each time. */
  factor: number;
}

/**
 * A full-jitter exponential backoff. The raw delay for an attempt is `baseMs * factor^attempt`,
 * clamped to `capMs`; the returned delay is a random point in `[0, raw]`. Full jitter spreads
 * retries across the whole window rather than clustering them, and the cap means an outage of any
 * length settles at a steady redial rate instead of drifting toward hours between tries.
 *
 * `random` returns a value in `[0, 1)`, as `Math.random` does; a test passes a fixed source.
 */
export function backoffDelay(attempt: number, options: BackoffOptions, random: () => number): number {
  const steps = Math.max(0, Math.floor(attempt));
  const raw = Math.min(options.capMs, options.baseMs * options.factor ** steps);
  return Math.floor(random() * raw);
}
