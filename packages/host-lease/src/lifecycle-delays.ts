/**
 * E2E-only lifecycle delay seam (lifecycle redesign §6.1): one awaited delay
 * before a named lifecycle boundary proceeds, so a test can make any boundary
 * as slow as a loaded machine makes it, deterministically. Each point fires
 * once per process: the first boundary to apply it waits, every later one
 * proceeds at once, so a delay on a repeated boundary (every record read)
 * never multiplies. Absent or spent, applying a point arms no timer.
 *
 * Electron Main owns the gate (`apps/desktop/src/lifecycle-delay-seam.ts`): it
 * reads `BRAINSTRIKE_E2E_LIFECYCLE_DELAYS` only in an unpackaged test-mode
 * launch, always removes it from its own environment so no child can inherit
 * it, and hands a child the points that child applies in that child's
 * environment. A child reads that entry once with `takeLifecycleDelays`, which
 * removes it again, so the child's own descendants never inherit it either.
 * This module is pure and Electron-free so any child can use it.
 */
export const LIFECYCLE_DELAYS_ENV = 'BRAINSTRIKE_E2E_LIFECYCLE_DELAYS';

export const LIFECYCLE_DELAY_POINTS = [
  'host-ready',
  'platform-ready',
  'record-read',
  'renderer-flush',
  'child-exit',
  'root-watch-subscribe',
] as const;
export type LifecycleDelayPoint = (typeof LIFECYCLE_DELAY_POINTS)[number];
export type LifecycleDelays = ReadonlyMap<LifecycleDelayPoint, number>;

const POINTS: ReadonlySet<string> = new Set(LIFECYCLE_DELAY_POINTS);
const MILLISECONDS = /^[1-9][0-9]*$/u;

function isPoint(value: string): value is LifecycleDelayPoint {
  return POINTS.has(value);
}

/**
 * `point:ms,point:ms`. An unknown or repeated point, or a delay that is not a
 * positive safe integer of milliseconds, is refused, never ignored.
 */
export function parseLifecycleDelays(raw: string): LifecycleDelays {
  const delays = new Map<LifecycleDelayPoint, number>();
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    const point = separator === -1 ? entry : entry.slice(0, separator);
    const value = separator === -1 ? '' : entry.slice(separator + 1);
    if (!isPoint(point)) {
      throw new Error(`${LIFECYCLE_DELAYS_ENV} names an unknown point: "${point}"`);
    }
    const ms = Number(value);
    if (!(MILLISECONDS.test(value) && Number.isSafeInteger(ms))) {
      throw new Error(
        `${LIFECYCLE_DELAYS_ENV} delay for ${point} must be a positive integer of milliseconds: "${value}"`
      );
    }
    if (delays.has(point)) {
      throw new Error(`${LIFECYCLE_DELAYS_ENV} names ${point} more than once`);
    }
    delays.set(point, ms);
  }
  return delays;
}

/** The `points` of `delays` that are set, in the format `parseLifecycleDelays` reads. */
export function formatLifecycleDelays(
  delays: LifecycleDelays,
  points: readonly LifecycleDelayPoint[] = LIFECYCLE_DELAY_POINTS
): string {
  return points
    .flatMap((point) => {
      const ms = delays.get(point);
      return ms === undefined ? [] : [`${point}:${ms}`];
    })
    .join(',');
}

/** The points each delay set has already fired; a set's configured values stay unchanged. */
const fired = new WeakMap<LifecycleDelays, Set<LifecycleDelayPoint>>();

/**
 * Waits the delay set for `point` the first time `point` is applied with
 * `delays`, and consumes it: unset or already fired, it resolves at once,
 * arming no timer. Forwarding (`formatLifecycleDelays`) still reads the
 * configured value, so each child process applies its points once too.
 */
export function lifecycleDelay(delays: LifecycleDelays, point: LifecycleDelayPoint): Promise<void> {
  const ms = delays.get(point);
  const spent = fired.get(delays) ?? new Set<LifecycleDelayPoint>();
  if (ms === undefined || spent.has(point)) {
    return Promise.resolve();
  }
  spent.add(point);
  fired.set(delays, spent);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Child side: the delays the parent handed this process, read once and removed
 * from `env` so this process's own children never inherit them. Empty when the
 * parent handed none.
 */
export function takeLifecycleDelays(
  env: Record<string, string | undefined> = process.env
): LifecycleDelays {
  const raw = env[LIFECYCLE_DELAYS_ENV];
  delete env[LIFECYCLE_DELAYS_ENV];
  return raw === undefined ? new Map() : parseLifecycleDelays(raw);
}
