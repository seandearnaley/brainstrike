/**
 * E2E-only lifecycle delay seam (lifecycle redesign §6.1): one awaited delay
 * before a named lifecycle boundary proceeds, so a test can make any boundary
 * as slow as a loaded machine makes it, deterministically. Absent a point,
 * applying it is a no-op that arms no timer.
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
  'indexer-request',
  'canonical-attach',
  'hidden-host-ready',
  'renderer-flush',
  'child-exit',
  'parcel-subscribe',
] as const;
export type LifecycleDelayPoint = (typeof LIFECYCLE_DELAY_POINTS)[number];
export type LifecycleDelays = ReadonlyMap<LifecycleDelayPoint, number>;

const POINTS: ReadonlySet<string> = new Set(LIFECYCLE_DELAY_POINTS);
const MILLISECONDS = /^[1-9][0-9]*$/;

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

/** Waits the delay set for `point`; resolves at once, arming no timer, when it is unset. */
export function lifecycleDelay(delays: LifecycleDelays, point: LifecycleDelayPoint): Promise<void> {
  const ms = delays.get(point);
  if (ms === undefined) {
    return Promise.resolve();
  }
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
