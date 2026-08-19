// BST-1328: host-level OS watcher liveness probe (test support only).
//
// WHY THIS EXISTS
// ---------------
// On some macOS hosts, delivery through `@parcel/watcher`'s FSEventStream usage
// goes intermittently DEAD: `subscribe()` resolves, the watcher reports
// `'healthy'`, and then no event ever arrives — with no error emitted. Measured
// on Darwin 25.5 arm64 (BST-1328): parcel's fs-events backend delivered 0/5 and
// 1/5 across versions 2.5.6 and 2.6.0, while Node's `fs.watch` (libuv) was
// 10/10 in the SAME process conditions. The version theory was refuted by those
// larger samples; the host's FSEventStream layer is the broken component.
//
// The consequence for tests is that every watcher test on such a host fails as
// an undifferentiated timeout, which is indistinguishable from "our watcher /
// invalidation logic is broken". This probe makes that distinction mechanical:
// it exercises the native backend and, only when that fails, a `fs.watch`
// CONTROL in the same conditions. Native-dead + control-alive is the signature
// of the known host fault; both dead means the harness itself (tmpdir,
// sandbox, permissions) cannot deliver events, which is NOT that fault and must
// never be quietly tolerated.
//
// DESIGN NOTES
// ------------
// - The sentinel is touched REPEATEDLY until the deadline rather than once.
//   A single write can legitimately land inside the subscribe window and be
//   lost forever even on a perfectly healthy host (see
//   `docs/agents/*` watcher-readiness notes: a 6ms margin was measured), which
//   would make a one-shot probe report a false "dead" verdict and skip tests
//   that should have run. Repeated touches remove that failure mode: a healthy
//   host delivers one of them.
// - The control probe is only run when the native backend failed, so the cost
//   on a healthy host is one subscribe plus one touch (tens of milliseconds).
// - Backend selection reuses production's `selectParcelBackend()` rather than a
//   private platform map, so the probe can never drift from what the app does.
import { watch } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadParcelWatcher,
  type ParcelBackendName,
  selectParcelBackend,
} from '../adapters/parcel-backend.js';

/**
 * Outcome of a liveness probe.
 *
 * - `alive` — the native backend delivered. Watcher tests are meaningful; any
 *   subsequent failure is OUR bug.
 * - `native-dead-control-alive` — the native backend delivered nothing while
 *   `fs.watch` did. This is the BST-1328 host fault: the platform layer is
 *   dead, so watcher tests cannot say anything about our code.
 * - `native-dead-control-dead` — nothing delivered at all. NOT the known host
 *   fault (libuv would still work under it); the harness or filesystem itself
 *   is not delivering events. Must fail loudly, never be skipped past.
 */
export type WatcherLivenessVerdict =
  | 'alive'
  | 'native-dead-control-alive'
  | 'native-dead-control-dead';

export interface WatcherLivenessResult {
  /** Backend the probe subscribed with, from production's own selector. */
  readonly backend: ParcelBackendName;
  /** `fs.watch` control result; `null` when the control was not needed. */
  readonly controlDelivered: boolean | null;
  /** Human-readable diagnosis, suitable as a test failure or skip reason. */
  readonly detail: string;
  /** Wall-clock cost of the whole probe. */
  readonly elapsedMs: number;
  readonly nativeDelivered: boolean;
  readonly timeoutMs: number;
  readonly verdict: WatcherLivenessVerdict;
}

export interface WatcherLivenessProbeOptions {
  /** Per-layer deadline (native and, if run, control each get this budget). */
  readonly timeoutMs?: number;
  /** Interval between sentinel touches. */
  readonly touchIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_TOUCH_INTERVAL_MS = 100;

/**
 * Repeatedly touch a sentinel inside `root` until `delivered()` reports true or
 * the deadline expires. Returns whether delivery was observed.
 */
async function touchUntilDelivered(
  root: string,
  delivered: () => boolean,
  timeoutMs: number,
  touchIntervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let sequence = 0;
  while (Date.now() < deadline) {
    sequence += 1;
    await writeFile(join(root, `liveness-${sequence}.txt`), `probe ${sequence}`);
    await new Promise((resolve) => setTimeout(resolve, touchIntervalMs));
    if (delivered()) {
      return true;
    }
  }
  return delivered();
}

/** Subscribe with the production backend and see whether any event arrives. */
async function probeNative(
  backend: ParcelBackendName,
  timeoutMs: number,
  touchIntervalMs: number
): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), 'bst1328-native-'));
  let eventCount = 0;
  const watcher = await loadParcelWatcher();
  const subscription = await watcher.subscribe(
    root,
    (error, batch) => {
      if (error) {
        return;
      }
      eventCount += batch.length;
    },
    { backend }
  );
  try {
    return await touchUntilDelivered(root, () => eventCount > 0, timeoutMs, touchIntervalMs);
  } finally {
    await subscription.unsubscribe();
    await rm(root, { force: true, recursive: true });
  }
}

/** The libuv CONTROL: same shape, different kernel mechanism. */
async function probeControl(timeoutMs: number, touchIntervalMs: number): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), 'bst1328-control-'));
  let eventCount = 0;
  const watcher = watch(root, () => {
    eventCount += 1;
  });
  try {
    return await touchUntilDelivered(root, () => eventCount > 0, timeoutMs, touchIntervalMs);
  } finally {
    watcher.close();
    await rm(root, { force: true, recursive: true });
  }
}

function describe(
  backend: ParcelBackendName,
  verdict: WatcherLivenessVerdict,
  timeoutMs: number
): string {
  if (verdict === 'alive') {
    return `@parcel/watcher '${backend}' backend delivers events on this host.`;
  }
  if (verdict === 'native-dead-control-alive') {
    return (
      `[BST-1328] The host's OS watcher layer is DEAD: @parcel/watcher's '${backend}' backend ` +
      `delivered NO events within ${timeoutMs}ms of repeated writes, while Node's fs.watch ` +
      '(libuv) delivered events in the same process under the same conditions. ' +
      'That discriminates the platform layer from this repo: brainstrike watcher code is NOT ' +
      'implicated by this result. Known-intermittent on Darwin 25.5 (macOS 16.x); a reboot has ' +
      'restored delivery in past occurrences.'
    );
  }
  return (
    `[BST-1328] NEITHER @parcel/watcher's '${backend}' backend NOR Node's fs.watch delivered ` +
    `any event within ${timeoutMs}ms of repeated writes. This is NOT the known FSEvents host ` +
    'fault (libuv keeps working under that one) — the test filesystem itself is not delivering ' +
    'events. Check sandboxing, TMPDIR permissions, or a full filesystem.'
  );
}

/**
 * Run the probe. Costs one subscribe + one touch on a healthy host; only pays
 * for the `fs.watch` control when the native backend has already failed.
 */
export async function probeWatcherLiveness(
  options: WatcherLivenessProbeOptions = {}
): Promise<WatcherLivenessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const touchIntervalMs = options.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS;
  const backend = selectParcelBackend();
  const startedAt = Date.now();

  const nativeDelivered = await probeNative(backend, timeoutMs, touchIntervalMs);
  if (nativeDelivered) {
    const verdict: WatcherLivenessVerdict = 'alive';
    return {
      backend,
      controlDelivered: null,
      detail: describe(backend, verdict, timeoutMs),
      elapsedMs: Date.now() - startedAt,
      nativeDelivered: true,
      timeoutMs,
      verdict,
    };
  }

  const controlDelivered = await probeControl(timeoutMs, touchIntervalMs);
  const verdict: WatcherLivenessVerdict = controlDelivered
    ? 'native-dead-control-alive'
    : 'native-dead-control-dead';
  return {
    backend,
    controlDelivered,
    detail: describe(backend, verdict, timeoutMs),
    elapsedMs: Date.now() - startedAt,
    nativeDelivered: false,
    timeoutMs,
    verdict,
  };
}

let cachedProbe: Promise<WatcherLivenessResult> | null = null;

/**
 * Per-process memoized {@link probeWatcherLiveness}. Watcher liveness is a
 * property of the host, so re-probing per test file only adds wall-clock cost.
 * Memoizing the PROMISE also collapses concurrent callers into one probe.
 */
export function probeWatcherLivenessOnce(
  options: WatcherLivenessProbeOptions = {}
): Promise<WatcherLivenessResult> {
  cachedProbe ??= probeWatcherLiveness(options);
  return cachedProbe;
}

/** Test seam: forget the memoized verdict. */
export function resetWatcherLivenessCache(): void {
  cachedProbe = null;
}

/** Minimal structural view of vitest's TestContext, so this module stays test-framework-free. */
export interface SkippableTestContext {
  skip: (note?: string) => void;
}

/**
 * Skip the current test ONLY when the host's platform watcher layer is proven
 * dead while libuv still works — the BST-1328 signature.
 *
 * This is deliberately narrow. It is not a blanket "watchers are flaky" escape
 * hatch: a healthy host never reaches it, and the `native-dead-control-dead`
 * case (a broken harness rather than a broken host) is left to FAIL. The reason
 * is printed to stderr as well as attached to the skip, because a skip nobody
 * reads is the same as a silent pass.
 */
export function skipWhenHostWatcherDead(
  ctx: SkippableTestContext,
  result: WatcherLivenessResult
): void {
  if (result.verdict !== 'native-dead-control-alive') {
    return;
  }
  const note = `SKIPPED — host watcher layer is dead. ${result.detail}`;
  // biome-ignore lint/suspicious/noConsole: a skip must be visible in the log, not just in the summary.
  console.warn(`\n${note}\n`);
  ctx.skip(note);
}
