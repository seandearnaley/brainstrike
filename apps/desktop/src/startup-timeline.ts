/**
 * One launch's startup timeline, kept on Node's own performance timeline: each
 * milestone is a `startup:<name>` mark whose time counts from process start.
 * Marks live in the process-wide timeline, so the separately bundled Main
 * bootstrap and Main runtime record into the same one.
 */
import { performance } from 'node:perf_hooks';
import type { WebContents } from 'electron';

export const STARTUP_MILESTONES = [
  'bootstrap',
  'shellEnvironment',
  'windowShown',
  'firstContentfulPaint',
  'agentHostReady',
  'indexReady',
] as const;
export type StartupMilestone = (typeof STARTUP_MILESTONES)[number];

/** Milliseconds from process start for each milestone that happened; the rest are absent. */
export interface StartupTimeline {
  readonly absent: readonly StartupMilestone[];
  readonly ms: Readonly<Partial<Record<StartupMilestone, number>>>;
}

const MARK_PREFIX = 'startup:';

export function startupTimeline(
  marks: readonly Pick<PerformanceEntry, 'name' | 'startTime'>[]
): StartupTimeline {
  const absent: StartupMilestone[] = [];
  const ms: Partial<Record<StartupMilestone, number>> = {};
  for (const milestone of STARTUP_MILESTONES) {
    const mark = marks.find((entry) => entry.name === `${MARK_PREFIX}${milestone}`);
    if (mark) {
      ms[milestone] = Math.round(mark.startTime);
    } else {
      absent.push(milestone);
    }
  }
  return { absent, ms };
}

/** Marks a milestone now, or at `startTime` on Main's clock; a launch keeps its first occurrence. */
export function markStartupMilestone(milestone: StartupMilestone, startTime?: number): void {
  const name = `${MARK_PREFIX}${milestone}`;
  if (performance.getEntriesByName(name, 'mark').length > 0) {
    return;
  }
  performance.mark(name, startTime === undefined ? undefined : { startTime });
}

export function readStartupTimeline(): StartupTimeline {
  return startupTimeline(performance.getEntriesByType('mark'));
}

// Resolves with the epoch time of the document's first contentful paint, read
// from the renderer's own paint timing (buffered, so a paint before the call counts).
const FIRST_CONTENTFUL_PAINT_SCRIPT = `new Promise((resolve) => {
  new PerformanceObserver((list, observer) => {
    const [entry] = list.getEntriesByName('first-contentful-paint');
    if (entry) {
      observer.disconnect();
      resolve(performance.timeOrigin + entry.startTime);
    }
  }).observe({ buffered: true, type: 'paint' });
})`;

/** Marks the loaded renderer's first contentful paint on Main's timeline. */
export async function markRendererFirstPaint(
  contents: Pick<WebContents, 'executeJavaScript'>
): Promise<void> {
  const paintedAt: unknown = await contents.executeJavaScript(FIRST_CONTENTFUL_PAINT_SCRIPT);
  if (typeof paintedAt !== 'number' || !Number.isFinite(paintedAt)) {
    throw new TypeError('The renderer reported no first contentful paint time.');
  }
  // Both time origins count from the Unix epoch, so the difference is Main's clock.
  markStartupMilestone('firstContentfulPaint', paintedAt - performance.timeOrigin);
}
