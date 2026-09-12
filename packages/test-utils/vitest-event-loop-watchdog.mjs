// BST-1221: kill a vitest worker whose event loop is blocked, so the lane fails
// closed in seconds instead of hanging until the CI job limit.
//
// THE FAILURE THIS CATCHES
// -----------------------
// PGlite 0.5.8's synchronous protocol loop (`execProtocolRawSync`) retries
// `_PostgresMainLoopOnce` forever when the WASM call traps with anything other
// than its longjmp exit code. Under Node 26.8.2 that trap
// (`RuntimeError: function signature mismatch` in `$palloc`) reproduces
// deterministically for some import layouts. The worker then spins at 100% CPU
// with its event loop blocked: vitest's `testTimeout` is a timer in that same
// loop and can never fire, the worker never reports, turbo prints nothing, and
// the job is cancelled at its 30-minute limit with no verdict (Unit (rest),
// run 34653237231). Evidence and mechanism are recorded on BST-1221.
//
// A blocked loop can only be observed from outside it. This module starts a
// `worker_threads` watchdog with its own event loop; the main thread posts a
// heartbeat every `heartbeatMs`. When the watchdog sees no heartbeat for
// `stallMs`, it writes one diagnostic naming the running test to stderr and
// kills the whole process with SIGKILL. Vitest then sees a lost worker and
// `LostTestFileReporter` fails the run on the missing verdict, naming the file.
//
// It is NOT a retry, timeout increase or suppression: the failure still fails,
// it just fails in `stallMs` with a name instead of in 30 minutes without one.
//
// Outcome by pool: in a `forks` lane the killed process is the child worker, the
// vitest main process survives, and `LostTestFileReporter` fails the run naming
// the lost file. In a `threads` lane the vitest worker is itself a thread of the
// vitest process, so SIGKILL takes the whole run: the single stderr line above
// is the only attribution. Both end the hang in `stallMs` with a name.
//
// Debugging opt-out: a paused debugger blocks the loop on purpose, so the
// watchdog does not start when the process was launched with `--inspect*`
// (execArgv or NODE_OPTIONS); it says so once on stderr.
//
// A plain `.mjs` at the package root (like `vitest-lost-file-reporter.mjs`):
// setup files load in the vitest worker before any package build, so this
// must not depend on `dist/`.
import { writeSync } from 'node:fs';
import inspector from 'node:inspector';
import { Worker } from 'node:worker_threads';

const STALL_ENV = 'BRAINSTRIKE_VITEST_EVENT_LOOP_STALL_MS';
const DEFAULT_STALL_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 1000;
const REGISTRY = Symbol.for('brainstrike.vitest.eventLoopWatchdog');

// Inline CommonJS source for the watchdog thread. It is evaluated with an
// empty execArgv, so it is always CommonJS regardless of how the parent was
// started, and it never needs a file URL (vitest's thread pool rewrites
// `import.meta.url` to a non-file scheme inside transformed setup modules).
const WATCHDOG_THREAD_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { writeSync } = require('node:fs');
let lastHeartbeatAt = Date.now();
let label = workerData.label;
parentPort.on('message', (message) => {
  lastHeartbeatAt = Date.now();
  if (message && typeof message.label === 'string') {
    label = message.label;
  }
});
setInterval(() => {
  const silentMs = Date.now() - lastHeartbeatAt;
  if (silentMs < workerData.stallMs) {
    return;
  }
  writeSync(
    2,
    '[vitest-event-loop-watchdog] worker ' + process.pid + ' event loop blocked for ' + silentMs +
      'ms while running ' + JSON.stringify(label) + '. Killing the worker with SIGKILL so the ' +
      'lost test file fails closed (LostTestFileReporter) instead of hanging the lane. ' +
      'BST-1221 wedge class: PGlite protocol loop spinning on a WASM trap.\\n'
  );
  process.kill(process.pid, 'SIGKILL');
}, workerData.pollMs);
`;

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${label} must be a positive integer of milliseconds, got ${JSON.stringify(value)}.`
    );
  }
  return value;
}

function isInspectorAttached() {
  // `inspector.url()` is the authoritative answer (it also covers a debugger
  // attached later via SIGUSR1); the flag scan keeps `--inspect-brk` covered
  // before the session is active, and ignores `--inspect-port`, which only
  // configures a port.
  if (inspector.url() !== undefined) {
    return true;
  }
  const flags = [...process.execArgv, ...(process.env['NODE_OPTIONS'] ?? '').split(/\s+/)];
  return flags.some(
    (flag) =>
      flag === '--inspect' || flag.startsWith('--inspect=') || flag.startsWith('--inspect-brk')
  );
}

function resolveStallMs(explicit) {
  if (explicit !== undefined) {
    return assertPositiveInteger(explicit, 'stallMs');
  }
  const raw = process.env[STALL_ENV];
  if (raw === undefined || raw === '') {
    return DEFAULT_STALL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${STALL_ENV} must be a positive integer of milliseconds, got ${JSON.stringify(raw)}.`
    );
  }
  return parsed;
}

/**
 * Starts (once per process) the out-of-loop watchdog. Returns the running
 * instance so a vitest setup file can label the current test.
 *
 * @param {{ heartbeatMs?: number; label?: string; stallMs?: number }} [options]
 * @returns {{ setLabel: (label: string) => void; stop: () => void }}
 */
export function startEventLoopWatchdog(options = {}) {
  // In a `threads` pool the vitest worker is itself a worker thread; the
  // watchdog is then a nested thread and SIGKILL takes the whole vitest
  // process. The lane still fails in `stallMs` with the diagnostic line on
  // stderr naming the test, which is the outcome this exists for.
  const existing = globalThis[REGISTRY];
  if (existing) {
    return existing;
  }
  const stallMs = resolveStallMs(options.stallMs);
  const heartbeatMs = assertPositiveInteger(
    options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    'heartbeatMs'
  );
  // Validation is independent of the runtime environment: a mis-tuned budget
  // fails loudly under a debugger too, instead of only in CI.
  if (heartbeatMs >= stallMs) {
    throw new Error(`heartbeatMs (${heartbeatMs}) must be shorter than stallMs (${stallMs}).`);
  }
  if (isInspectorAttached()) {
    writeSync(
      2,
      '[vitest-event-loop-watchdog] inspector attached; watchdog not started for this process.\n'
    );
    const inert = { setLabel: () => {}, stop: () => {} };
    globalThis[REGISTRY] = inert;
    return inert;
  }
  const worker = new Worker(WATCHDOG_THREAD_SOURCE, {
    eval: true,
    // The thread needs no flags; inheriting the parent's execArgv (vitest's
    // --require/--conditions, or a probe's --input-type) is unnecessary and
    // --input-type is rejected for file-based workers.
    execArgv: [],
    workerData: {
      label: options.label ?? 'no test started',
      pollMs: Math.max(10, Math.floor(heartbeatMs / 2)),
      stallMs,
    },
  });
  // The watchdog must never keep a finished worker process alive.
  worker.unref();
  worker.on('error', (error) => {
    writeSync(2, `[vitest-event-loop-watchdog] watchdog thread failed: ${String(error)}\n`);
  });
  const heartbeat = setInterval(() => {
    worker.postMessage({});
  }, heartbeatMs);
  heartbeat.unref();
  const instance = {
    setLabel: (label) => {
      worker.postMessage({ label });
    },
    stop: () => {
      clearInterval(heartbeat);
      void worker.terminate();
      delete globalThis[REGISTRY];
    },
  };
  globalThis[REGISTRY] = instance;
  return instance;
}
