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
// it exercises a RAW native subscription — no brainstrike code in the path
// beyond backend selection — and, only when that fails, a `fs.watch` CONTROL in
// the same conditions.
//
// The load-bearing fact is whether the raw binding delivered: if it did not,
// nothing above it can be blamed. The control then grades HOW degraded the host
// is. Note that on macOS libuv's `fs.watch` rides the same FSEventStream
// subsystem, so "control also silent" is a worse host, not a different
// diagnosis — measured on this host, the control alternated between delivering
// and not across runs minutes apart.
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
 *   `fs.watch` did. The BST-1328 host fault: the platform layer under our
 *   watcher is dead, so watcher tests cannot say anything about our code.
 * - `native-dead-control-dead` — nothing delivered at all. On macOS this is the
 *   MORE degraded form of the same fault (libuv shares FSEventStream there);
 *   elsewhere it would suggest a sandboxed or permission-restricted TMPDIR.
 *   Either way the platform, not this repo, is what failed to deliver.
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
    `[BST-1328] NO filesystem events were delivered within ${timeoutMs}ms of repeated writes — ` +
    `neither by @parcel/watcher's '${backend}' backend nor by Node's fs.watch (libuv). The host ` +
    'is not delivering events at all, so nothing here implicates brainstrike watcher code. ' +
    'On macOS both mechanisms ride the SAME FSEventStream subsystem, so this is the degraded ' +
    'form of the known host fault rather than a separate one; on other platforms it would ' +
    'instead point at a sandboxed or permission-restricted TMPDIR.'
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

/** Minimal structural view of vitest's TestContext, so this module stays test-framework-free. */
export interface SkippableTestContext {
  skip: (note?: string) => void;
}

let platformSkipCount = 0;

/** Tests this module skipped for a dead platform, in THIS worker process. */
export function getPlatformSkipCount(): number {
  return platformSkipCount;
}

/**
 * Fail the suite when any test was skipped because the platform was dead.
 *
 * Call from `afterAll`. Without it a degraded host produces a GREEN lane whose
 * tests verified nothing — measured before this existed: 6 of 10 desktop runs
 * exited 0 with both tests skipped, and 1 of 10 file-system runs exited 0 with
 * four. Visible skips are not enough; an exit code of 0 is what CI and a human
 * skimming a log actually read, and "green because nothing ran" is the same
 * false-confidence shape this repo already treats as a defect elsewhere.
 *
 * The per-test skips still earn their keep: they keep each test's own result
 * honest ("not run" rather than "failed") and stop a dead host from emitting N
 * near-identical timeouts. This turns them into ONE explicit lane failure that
 * says how many tests were lost and why.
 */
export function assertNoPlatformSkips(): void {
  if (platformSkipCount === 0) {
    return;
  }
  throw new Error(
    `[BST-1328] ${platformSkipCount} test(s) in this file did not run: the host's watcher ` +
      'layer was not delivering events when they needed it (see the per-test skip reasons ' +
      'above). Failing the lane because a run that skipped its subject cannot be reported as ' +
      'a pass. This is a HOST fault, not a regression in this repo — on macOS a reboot has ' +
      'restored FSEvents delivery in past occurrences.'
  );
}

/**
 * Attribute a watcher-test failure to the platform or to this repo, by probing
 * liveness AT THE MOMENT OF FAILURE, then either skipping or rethrowing.
 *
 * WHY POST-HOC RATHER THAN PRE-FLIGHT
 * -----------------------------------
 * A pre-flight gate cannot decide this correctly, because the fault is
 * INTERMITTENT rather than steady. Measured on the BST-1328 host while building
 * this: a pre-flight probe reported `alive`, the first test then passed, and the
 * platform went silent for the very next test in the SAME process — so the gate
 * had already made its (now stale) decision. Probing at the moment the event
 * failed to arrive asks the question at the only time the answer is meaningful.
 *
 * The decision turns on ONE fact: did a RAW `@parcel/watcher` subscription — no
 * brainstrike code in the path beyond backend selection — deliver anything?
 *
 * - raw binding silent → SKIP. Our wrapper cannot be blamed for events the
 *   binding beneath it never produced, so the test has nothing to say. Both
 *   silent verdicts qualify: on macOS libuv's `fs.watch` rides the same
 *   FSEventStream subsystem, so "libuv also silent" is a MORE degraded host,
 *   not a different diagnosis.
 * - raw binding delivered → RETHROW with the verdict appended. The platform was
 *   working while our watcher missed the event: positive evidence the failure is
 *   OURS, which is exactly the discrimination a bare timeout never provided.
 *
 * This never widens a deadline and never silently swallows a regression: it runs
 * only on the failure path, and the un-skippable oracle in
 * `parcel-binding.integration.test.ts` still fails loudly on the same host, so a
 * dead platform can never present as a green run.
 */
export async function attributeWatcherFailure(
  ctx: SkippableTestContext,
  error: unknown,
  options: WatcherLivenessProbeOptions = {}
): Promise<never> {
  const result = await probeWatcherLiveness(options);
  const original = error instanceof Error ? error.message : String(error);

  if (!result.nativeDelivered) {
    platformSkipCount += 1;
    const note = `SKIPPED — host watcher layer is dead. ${result.detail} Original failure: ${original}`;
    // biome-ignore lint/suspicious/noConsole: a skip must be visible in the log, not only in the summary.
    console.warn(`\n${note}\n`);
    ctx.skip(note);
  }

  if (error instanceof Error) {
    error.message = `${original}\n\n[BST-1328 attribution] ${result.detail}`;
    throw error;
  }
  throw new Error(`${original}\n\n[BST-1328 attribution] ${result.detail}`);
}
