/**
 * FenceExecutor — mode one of the code-execution seam (BST-1062).
 *
 * Wraps an injected interpreter in `@anthropic-ai/sandbox-runtime`'s OS-level
 * fence (Seatbelt on macOS, bubblewrap on Linux). No Docker, no VM.
 *
 * Node-only: reachable through the `@brainstrike/agent/fence-executor` subpath
 * export, never from the root or browser-safe entrypoints.
 *
 * Two facts about srt drive the shape of this module:
 *
 * 1. `SandboxManager` is a PROCESS-GLOBAL singleton. `initialize()` is a
 *    no-op once an initialization promise exists, and the network proxy reads
 *    the module-level config at request time. So the session is initialized
 *    once per process and every execution pushes its own policy through
 *    `updateConfig()` (proxy) plus `wrapWithSandbox*`'s per-command config
 *    override (filesystem). Both are needed: the wrap-time override alone
 *    would leave the proxy filtering on a stale allow-list.
 * 2. Because that state is global, executions are SERIALIZED process-wide.
 *    Two concurrent runs with different policies would otherwise interleave
 *    `updateConfig()` calls and one would silently run under the other's
 *    network allow-list.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { createLogger } from '@brainstrike/logging';

import {
  assertExecRequestSatisfiable,
  type CodeExecutor,
  type CodeExecutorFactory,
  ExecAbortedError,
  type ExecInput,
  type ExecLanguage,
  type ExecPlatform,
  type ExecResult,
  type ExecutorCapabilities,
  execInputSchema,
} from '../code-execution';
import { buildSandboxRuntimeConfig } from './fence-policy';
import {
  FENCE_READINESS_TIMEOUT_MS,
  fenceReadinessFailure,
  fenceReadinessTimeout,
  probeFenceReadiness,
} from './fence-readiness';
import { FenceReadinessError } from './fence-readiness-error';

/** Grace period between the SIGTERM and the SIGKILL sent to the process tree. */
const KILL_GRACE_MS = 500;

/** Poll interval while confirming that a SIGKILLed process group is gone. */
const PROCESS_GROUP_EXIT_POLL_MS = 10;

/** Maximum confirmation window after SIGKILL before the fence fails closed. */
const PROCESS_GROUP_EXIT_CONFIRMATION_MS = 500;

const logger = createLogger('FenceExecutor');

/**
 * The ONLY host environment variables a sandboxed process inherits.
 *
 * The filesystem deny-list keeps `~/.aws` and `~/.npmrc` out of the sandbox;
 * inheriting `process.env` wholesale would hand the same secrets — plus this
 * app's provider API keys — straight to model-authored code through a channel
 * nothing checks. So the environment is an allow-list, not a pass-through, and
 * the decision lives here rather than being whatever srt's current version
 * happens to return.
 *
 * Anything an interpreter additionally needs is named on its
 * {@link FenceInterpreter.env}.
 */
export const INHERITED_ENV_VARS: readonly string[] = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'TMPDIR',
  'TZ',
];

/** How long to wait for the stdio pipes to close after the root process exits. */
const DRAIN_AFTER_EXIT_MS = 250;

/**
 * The binary that runs a language's script. Supplied by the host (BST-1061
 * owns resolving the bundled CPython), so this module never guesses a path.
 */
export interface FenceInterpreter {
  readonly args?: readonly string[];
  readonly command: string;
  /**
   * Extra environment this interpreter needs (a bundled CPython's
   * `PYTHONHOME`/`PYTHONPATH`, say). Nothing else from the host environment
   * reaches the sandbox — see {@link INHERITED_ENV_VARS} — so anything
   * required must be named here, visibly.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Extension for the script file written into scratchDir, without the dot. */
  readonly scriptExtension: string;
}

export type FenceInterpreterMap = Readonly<Partial<Record<ExecLanguage, FenceInterpreter>>>;

export interface FenceExecutorOptions {
  readonly interpreters: FenceInterpreterMap;
}

export class FenceUnsupportedPlatformError extends FenceReadinessError {
  override readonly code = 'fence_unsupported_platform' as const;

  constructor(hostPlatform: string) {
    super(
      'sandbox_unsupported_runtime',
      `The OS fence requires a supported macOS (Seatbelt) or Linux (bubblewrap) runtime; this host reports '${hostPlatform}' and cannot provide it. No user code ran. Use a supported host; no weaker execution mode is available.`
    );
    this.name = 'FenceUnsupportedPlatformError';
  }
}

export class FenceUnsupportedLanguageError extends Error {
  readonly code = 'fence_unsupported_language' as const;
  readonly language: ExecLanguage;

  constructor(language: ExecLanguage, available: readonly ExecLanguage[]) {
    super(
      `No interpreter was injected for '${language}'; this fence can run ${available.length > 0 ? available.join(', ') : 'nothing'}.`
    );
    this.name = 'FenceUnsupportedLanguageError';
    this.language = language;
  }
}

export class FenceExecutorDisposedError extends Error {
  readonly code = 'fence_executor_disposed' as const;

  constructor() {
    super('This fence executor has been disposed; create a new one to run more code.');
    this.name = 'FenceExecutorDisposedError';
  }
}

/** A request or construction the fence refuses outright — never coerced. */
export class FenceInvalidRequestError extends Error {
  readonly code = 'fence_invalid_request' as const;

  constructor(message: string) {
    super(message);
    this.name = 'FenceInvalidRequestError';
  }
}

/**
 * The request's whole timeout elapsed while it waited behind other executions,
 * so nothing was ever spawned. Distinct from a run that timed out: no code
 * executed, so there is no `ExecResult` to report.
 */
export class FenceQueueTimeoutError extends Error {
  readonly code = 'fence_queue_timeout' as const;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `The ${timeoutMs}ms budget elapsed while this execution waited behind others; no code was run. Executions are serialized because sandbox-runtime's session state is process-global.`
    );
    this.name = 'FenceQueueTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The fence could not confirm that a process group is gone. The executor
 * rejects rather than reporting a successful run, and the tracked group blocks
 * later policy installation until a probe confirms that it has disappeared.
 */
export class FenceProcessGroupTeardownError extends Error {
  readonly code = 'fence_process_group_teardown_failed' as const;
  override readonly cause: unknown;
  readonly outcome: ExecResult | undefined;
  readonly pid: number;

  constructor(pid: number, cause: unknown, outcome?: ExecResult) {
    super(
      `Process-group teardown for pid ${pid} could not be confirmed; later fenced executions are blocked until the group disappears.`,
      { cause }
    );
    this.name = 'FenceProcessGroupTeardownError';
    this.cause = cause;
    this.outcome = outcome;
    this.pid = pid;
  }
}

/**
 * The explicit `darwin`/`linux` list is LOAD-BEARING and must not be
 * "simplified" to `SandboxManager.isSupportedPlatform()` alone (BST-1068).
 *
 * srt's own probe returns TRUE on Windows — its Windows fence is real (a
 * dedicated `srt-sandbox` account, kernel WFP filters, NTFS DACLs) — and
 * `currentExecPlatform()` already accepts `'win32'`. So dropping this literal
 * would silently enable Windows with a truthful `os-fence` capability and a
 * QUIETLY WRONG filesystem policy: Windows srt fixes filesystem scope at
 * `initialize()` and supports neither the per-execution `updateConfig` nor the
 * per-command config override this executor relies on, so every execution
 * after the first would run under the first execution's policy while claiming
 * to honour its own. That is the exact silent degradation the seam forbids,
 * and it would present as a working sandbox.
 *
 * Windows stays unavailable until the mechanism can express a per-execution
 * `ExecPolicy` — not merely until it is out of alpha.
 */
export function isFenceSupported(): boolean {
  return (platform === 'darwin' || platform === 'linux') && SandboxManager.isSupportedPlatform();
}

// ---------------------------------------------------------------------------
// Process-global srt session (see the module header for why this is global).
// ---------------------------------------------------------------------------

let activeSessions = 0;
let sessionInitialized = false;
let commandQueue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = commandQueue.then(task, task);
  commandQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function applySessionConfig(config: SandboxRuntimeConfig): Promise<void> {
  if (!sessionInitialized) {
    // Throws (rather than degrading) when the platform's fence dependencies
    // are missing — e.g. bubblewrap or ripgrep absent on Linux.
    await SandboxManager.initialize(config);
    sessionInitialized = true;
  }
  // Always re-apply: `initialize()` is a no-op if anything else in this
  // process initialized first, and the network proxy reads this config at
  // request time. Without it a run could silently inherit another policy.
  SandboxManager.updateConfig(config);
}

async function releaseSession(): Promise<void> {
  activeSessions -= 1;
  if (activeSessions === 0 && sessionInitialized) {
    sessionInitialized = false;
    await SandboxManager.reset();
  }
}

/**
 * The caller is bounded even if an upstream initialization never settles. The
 * serialized task retains the lock until late work and cleanup have joined:
 * timing out must not let another execution race a late global config update.
 * Only successful construction retains a session; failed attempts can retry.
 */
async function acquireReadySession(callerSignal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  let rejectAborted: (error: unknown) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => rejectAborted(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = runExclusive(async () => {
    try {
      signal.throwIfAborted();
      // A busy executor does not make this host unready. The caller's signal
      // bounds queue wait; the probe ceiling starts only after acquisition.
      timer = setTimeout(
        () => controller.abort(fenceReadinessTimeout()),
        FENCE_READINESS_TIMEOUT_MS
      );
      const deadline = Date.now() + FENCE_READINESS_TIMEOUT_MS;
      assertNoSurvivingProcessGroups();
      await probeFenceReadiness({
        applyConfig: applySessionConfig,
        deadline,
        signal,
        spawn: (options) =>
          spawnFenced({ ...options, env: buildSandboxEnv(options.env, undefined) }),
      });
      signal.throwIfAborted();
      activeSessions += 1;
    } catch (error) {
      let failure = fenceReadinessFailure(error);
      // Log before cancellation returns its original reason. Expose aggregate
      // members explicitly: log redaction does not copy non-enumerable errors.
      logger.warn('Sandbox readiness failed', {
        error: failure,
        errors: failure.cause instanceof AggregateError ? failure.cause.errors : undefined,
        reason: failure.reason,
      });
      // Even failed initialize() can leave singleton resources. Never reset
      // another live executor's session, and never race a still-running probe.
      if (activeSessions === 0) {
        sessionInitialized = false;
        try {
          await SandboxManager.reset();
        } catch (cleanupError) {
          logger.error('Failed to reset sandbox after readiness failure', { error: cleanupError });
          failure = fenceReadinessFailure(failure, [cleanupError]);
        }
      }
      if (signal.aborted) {
        throw signal.reason;
      }
      throw failure;
    }
  });
  try {
    await Promise.race([pending, interrupted]);
  } catch (error) {
    // An abort can win after pending acquired a lease but before its promise
    // reaches the caller. Release only a successful late acquisition, under
    // the same lock; a rejected probe owns no lease to decrement.
    void pending
      .then(
        () => runExclusive(releaseSession),
        () => {}
      )
      .catch((cleanupError: unknown) => {
        logger.error('Failed to release abandoned sandbox session', { error: cleanupError });
      });
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

/** POSIX single-quote escaping — srt embeds the command in a `sh -c` string. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

type ProcessGroupState = 'alive' | 'gone' | 'unsignalable';

function signalTree(pid: number, signal: NodeJS.Signals | 0): ProcessGroupState {
  try {
    // Negative pid = the whole process group. `detached: true` made the child
    // the group leader, so every descendant it spawned is in this group.
    process.kill(-pid, signal);
    return 'alive';
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      return 'gone';
    }
    if (hasErrorCode(error, 'EPERM')) {
      return 'unsignalable';
    }
    throw error;
  }
}

function processGroupState(pid: number): ProcessGroupState {
  return signalTree(pid, 0);
}

export async function terminateProcessGroup(pid: number, signal: NodeJS.Signals): Promise<void> {
  let state: ProcessGroupState;
  try {
    state = signalTree(pid, signal);
  } catch (error) {
    throw new FenceProcessGroupTeardownError(pid, error);
  }
  if (state === 'gone') {
    return;
  }
  // NOTE: 'unsignalable' (EPERM) deliberately does NOT throw here. It is
  // inconclusive, not a denial — every member of this group is our own
  // descendant running as us, so a genuine permission failure is impossible
  // (the same reasoning terminal-ipc-handlers.ts records for its own group
  // kill). What it reports is the post-reap race: a just-SIGKILLed zombie
  // leader the kernel will not route a group signal through. SIGKILL therefore
  // falls through to the confirmation loop below, which resolves it; any other
  // signal returns with the rest, since it has no confirmation step to reach.
  if (signal !== 'SIGKILL') {
    return;
  }

  // kill(2) returning only means the signal was sent. The target can still run
  // before the kernel delivers SIGKILL, so settling at that point can expose a
  // later run's policy to a descendant that has not exited yet. Signal 0 is the
  // POSIX existence probe; ESRCH is the confirmation that the group is gone.
  const deadline = Date.now() + PROCESS_GROUP_EXIT_CONFIRMATION_MS;
  while (true) {
    try {
      state = processGroupState(pid);
    } catch (error) {
      throw new FenceProcessGroupTeardownError(pid, error);
    }
    if (state === 'gone') {
      return;
    }
    // 'unsignalable' (EPERM) is INCONCLUSIVE, so it polls on exactly like
    // 'alive' rather than short-circuiting either way. Measured: the group
    // reaches ESRCH ~7ms later, because EPERM here is the post-reap race — a
    // just-SIGKILLed zombie leader the kernel will not route a group signal
    // through — not a surviving group.
    //
    // Returning early on EPERM would be unsound in the other direction: a
    // process group can outlive its leader, so "the leader is gone" does not
    // prove the group is empty. Only ESRCH does, and only ESRCH returns.
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new FenceProcessGroupTeardownError(
        pid,
        new Error(
          state === 'unsignalable'
            ? `Process group ${pid} was still unsignalable ${PROCESS_GROUP_EXIT_CONFIRMATION_MS}ms after SIGKILL; teardown could not be confirmed.`
            : `Process group ${pid} still existed ${PROCESS_GROUP_EXIT_CONFIRMATION_MS}ms after SIGKILL.`
        )
      );
    }
    await delay(Math.min(PROCESS_GROUP_EXIT_POLL_MS, remainingMs), undefined, { ref: false });
  }
}

/**
 * Process groups with a live sandboxed run in them.
 *
 * `detached: true` is what makes the group kill possible, but it also means a
 * sandboxed process outlives this one — the per-run timeout is enforced by a
 * timer that dies with us. Reaping the groups on exit closes the normal
 * shutdown case. A hard crash (SIGKILL of the host) still cannot run this;
 * such a process stays inside its fence but keeps running, which is the
 * residual risk documented in docs/agents/code-execution.md.
 */
const liveProcessGroups = new Set<number>();
let exitReaperRegistered = false;

function assertNoSurvivingProcessGroups(): void {
  for (const pid of liveProcessGroups) {
    let state: ProcessGroupState;
    try {
      state = processGroupState(pid);
    } catch (error) {
      throw new FenceProcessGroupTeardownError(pid, error);
    }
    if (state === 'gone') {
      liveProcessGroups.delete(pid);
      continue;
    }
    throw new FenceProcessGroupTeardownError(
      pid,
      new Error(
        state === 'unsignalable'
          ? `Tracked process group ${pid} still exists but cannot be probed by this process.`
          : `Tracked process group ${pid} still exists.`
      )
    );
  }
}

function registerExitReaper(): void {
  if (exitReaperRegistered) {
    return;
  }
  exitReaperRegistered = true;
  process.once('exit', () => {
    for (const pid of liveProcessGroups) {
      try {
        const state = signalTree(pid, 'SIGKILL');
        if (state === 'unsignalable') {
          logger.error('Fenced process group could not be reaped during host exit', {
            code: 'fence_exit_reap_unsignalable',
            pid,
          });
        }
      } catch (error) {
        logger.error('Fenced process-group reaper failed during host exit', {
          code: 'fence_exit_reap_failed',
          error,
          pid,
        });
      }
    }
    liveProcessGroups.clear();
  });
}

/**
 * The environment the sandboxed process actually gets: the allow-list above,
 * plus this interpreter's declared additions, plus anything srt ADDED to the
 * env it handed back.
 *
 * That last part matters for forward-compatibility. On macOS/Linux srt bakes
 * its proxy/CA variables into the wrapped command string and returns
 * `process.env` unchanged, so today the diff is empty — but a later version
 * that starts returning them in `env` keeps working, while host secrets still
 * never cross, because only keys srt CHANGED are carried over.
 */
export function buildSandboxEnv(
  srtEnv: NodeJS.ProcessEnv,
  interpreterEnv: Readonly<Record<string, string>> | undefined
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) {
      inherited[name] = value;
    }
  }
  const addedBySrt: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(srtEnv)) {
    if (value !== undefined && process.env[name] !== value) {
      addedBySrt[name] = value;
    }
  }
  return { ...inherited, ...interpreterEnv, ...addedBySrt };
}

interface StreamCapture {
  /** Bytes the process produced beyond the cap, which were dropped. */
  omittedBytes: number;
  push(chunk: Buffer): void;
  text(): string;
}

/**
 * Captures up to `maxBytes` and COUNTS what it drops — the seam reports
 * omitted bytes per stream rather than one boolean, so the model can tell 1 KB
 * of loss from 100 MB. Dropping rather than buffering keeps a runaway loop from
 * exhausting memory; the stream keeps draining either way so the sandboxed
 * process never blocks on a full pipe.
 */
function createStreamCapture(maxBytes: number): StreamCapture {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const capture: StreamCapture = {
    omittedBytes: 0,
    push(chunk: Buffer): void {
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        capture.omittedBytes += chunk.length;
        return;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytes = maxBytes;
        capture.omittedBytes += chunk.length - remaining;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
  return capture;
}

type SpawnOutcome = ExecResult;

/**
 * Seams for the teardown state machine's unit tests. The close/exit/timeout
 * interleavings decide whether a process group can outlive its policy, and an
 * integration test cannot reproduce "descendant detaches stdio, root exits
 * later" on demand — so they are injectable and driven by a fake child.
 */
export interface FenceSpawnDeps {
  readonly killGroup: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  readonly spawnProcess: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ) => ChildProcessLike;
}

/** The slice of ChildProcess this module uses. */
export interface ChildProcessLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  readonly pid?: number | undefined;
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
}

const realSpawnDeps: FenceSpawnDeps = {
  killGroup: terminateProcessGroup,
  spawnProcess: (command, args, { cwd, env }) =>
    spawn(command, [...args], {
      cwd,
      detached: true,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
};

export interface SpawnFencedOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly deps?: FenceSpawnDeps;
  readonly env: NodeJS.ProcessEnv;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export function spawnFenced(options: SpawnFencedOptions): Promise<SpawnOutcome> {
  const { argv, cwd, deps = realSpawnDeps, env, maxOutputBytes, signal, timeoutMs } = options;
  const tracksLiveProcessGroup = deps === realSpawnDeps;
  return new Promise<SpawnOutcome>((resolvePromise, rejectPromise) => {
    const [command, ...args] = argv;
    if (!command) {
      rejectPromise(new Error('sandbox-runtime returned an empty command vector.'));
      return;
    }

    const child = deps.spawnProcess(command, args, { cwd, env });

    const stdout = createStreamCapture(maxOutputBytes);
    const stderr = createStreamCapture(maxOutputBytes);
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let teardownPromise: Promise<void> | undefined;

    const timers = new Set<NodeJS.Timeout>();
    const later = (ms: number, fn: () => void): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
    };
    const clearTimers = (): void => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    };

    /** Starts the one process-group teardown shared by every settlement path. */
    const startGroupTeardown = (): Promise<void> => {
      teardownPromise ??= (async () => {
        if (child.pid !== undefined) {
          await deps.killGroup(child.pid, 'SIGKILL');
          if (tracksLiveProcessGroup) {
            liveProcessGroups.delete(child.pid);
          }
        }
      })();
      return teardownPromise;
    };

    /** Runs on every settle path: stop timers and await the shared teardown. */
    const teardown = (): Promise<void> => {
      clearTimers();
      abortSubscription?.();
      // Tear the group down BEFORE settling, on every path. A descendant that
      // detached its stdio closes our pipes while still running, which fires
      // 'close' early — settling there would clear the pending SIGKILL and
      // return with the descendant alive, free to outlive the policy this run
      // was granted. Killing here means no exit path can leak the group.
      return startGroupTeardown();
    };

    const outcome = (): ExecResult => ({
      // The seam pins this: exitCode is null exactly when a signal killed the
      // process, and `signal` names it — no per-backend 124/-1 convention.
      exitCode,
      signal: exitSignal,
      stderr: stderr.text(),
      stderrOmittedBytes: stderr.omittedBytes,
      stdout: stdout.text(),
      stdoutOmittedBytes: stdout.omittedBytes,
      timedOut,
    });

    const teardownError = (error: unknown, completed?: ExecResult): Error => {
      if (error instanceof FenceProcessGroupTeardownError && completed === undefined) {
        return error;
      }
      return new FenceProcessGroupTeardownError(child.pid ?? -1, error, completed);
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      void teardown().then(
        () => rejectPromise(teardownError(error)),
        (cleanupError: unknown) =>
          rejectPromise(
            teardownError(
              new AggregateError([error, cleanupError], 'Process-group signaling failed')
            )
          )
      );
    };

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      const completed = outcome();
      void teardown().then(
        () => resolvePromise(completed),
        (error: unknown) => rejectPromise(teardownError(error, completed))
      );
    };

    /**
     * An abort is NOT a completed run, so it never resolves an ExecResult —
     * `exitCode: null, timedOut: false` would be distinguishable from a
     * timeout only by the absence of a flag. The partial output rides on the
     * typed error instead, so a debug bundle keeps it without any consumer
     * having to infer what happened.
     */
    const abortNow = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      void teardown().then(
        () => {
          rejectPromise(
            new ExecAbortedError({
              partialStderr: stderr.text(),
              partialStdout: stdout.text(),
              processStarted: true,
              stderrOmittedBytes: stderr.omittedBytes,
              stdoutOmittedBytes: stdout.omittedBytes,
            })
          );
        },
        (error: unknown) => {
          rejectPromise(
            new ExecAbortedError({
              cause: teardownError(error),
              partialStderr: stderr.text(),
              partialStdout: stdout.text(),
              processStarted: true,
              stderrOmittedBytes: stderr.omittedBytes,
              stdoutOmittedBytes: stdout.omittedBytes,
            })
          );
        }
      );
    };

    let abortSubscription: (() => void) | undefined;
    if (signal.aborted) {
      abortNow();
      return;
    }
    signal.addEventListener('abort', abortNow, { once: true });
    abortSubscription = () => signal.removeEventListener('abort', abortNow);

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      abortSubscription?.();
      if (tracksLiveProcessGroup && child.pid !== undefined) {
        liveProcessGroups.delete(child.pid);
      }
      rejectPromise(error);
    });

    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // 'close' waits for every pipe holder; a surviving grandchild can keep
      // stdout open forever. Give the pipes a short drain window, then finish
      // (which tears the group down) with the status we already have.
      later(DRAIN_AFTER_EXIT_MS, finish);
    });

    // Deliberately NOT settling on 'close' alone: pipes can close while the
    // group still has members. Wait for the root's exit status, then finish.
    child.on('close', () => {
      if (exitCode !== null || exitSignal !== null) {
        finish();
      }
    });

    const { pid } = child;
    if (pid === undefined) {
      // spawn() failed to produce a pid; the 'error' handler settles this.
      return;
    }
    if (tracksLiveProcessGroup) {
      registerExitReaper();
      liveProcessGroups.add(pid);
    }

    later(timeoutMs, () => {
      timedOut = true;
      void deps.killGroup(pid, 'SIGTERM').catch(fail);
      later(KILL_GRACE_MS, () => {
        // Start the one memoized SIGKILL confirmation, then retain the existing
        // drain window so an observed exit signal wins over the hard backstop.
        void startGroupTeardown().catch(fail);
        later(KILL_GRACE_MS, finish);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function currentExecPlatform(): ExecPlatform {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform;
  }
  throw new FenceUnsupportedPlatformError(platform);
}

/**
 * Builds a FenceExecutor. Throws on a platform this backend cannot fence —
 * there is no weaker mode to fall back to. Hosts should gate on
 * {@link createFenceExecutorFactory} so an unsupported host simply has no
 * fence capability and `resolveCodeExecutor('fence', host)` throws the seam's
 * own typed error.
 */
export async function createFenceExecutor(
  options: FenceExecutorOptions,
  signal?: AbortSignal
): Promise<CodeExecutor> {
  if (!isFenceSupported()) {
    throw new FenceUnsupportedPlatformError(platform);
  }

  const languages = Object.keys(options.interpreters) as ExecLanguage[];
  if (languages.length === 0) {
    throw new FenceInvalidRequestError(
      'A fence executor needs at least one injected interpreter; an executor that can run nothing must not be offered as a capability.'
    );
  }

  const execPlatform = currentExecPlatform();
  let disposed = false;
  await acquireReadySession(signal);

  const capabilities = (): ExecutorCapabilities => ({
    languages,
    maxIsolationTier: 'os-fence',
    platform: execPlatform,
    // The fence supports network via srt's allow-list proxy; a given run only
    // reaches the domains its policy names.
    supportsNetwork: true,
  });

  const execute = async (input: ExecInput): Promise<ExecResult> => {
    if (disposed) {
      throw new FenceExecutorDisposedError();
    }
    // The seam owns request shape (timeout/output bounds, path rules,
    // scratchDir ⊆ allowWrite, a real AbortSignal). Re-parsing here means a
    // caller that bypassed it still cannot reach a spawn.
    execInputSchema.parse(input);
    // The seam owns capability reconciliation too, so `fence` and `vm` cannot
    // answer it differently. Running a network-requesting script with the
    // network quietly off would be a stronger sandbox but a WRONG result.
    assertExecRequestSatisfiable(capabilities(), input);

    const interpreter = options.interpreters[input.language];
    if (!interpreter) {
      // Unreachable via the assertion above (languages is the interpreter key
      // set); kept so a future capabilities() edit cannot silently open a gap.
      throw new FenceUnsupportedLanguageError(input.language, languages);
    }

    // Throws on a policy the fence cannot honour (e.g. an allowRead that would
    // re-open a credential store) before anything is spawned. Resolves paths
    // to their canonical on-disk form first, so containment cannot be dodged
    // by a symlink or a case variant on a case-insensitive volume.
    const config = await buildSandboxRuntimeConfig(input.policy, input.scratchDir);
    const scriptPath = join(
      input.scratchDir,
      `brainstrike-exec-${randomUUID()}.${interpreter.scriptExtension}`
    );
    // The deadline starts HERE, not at spawn. Executions are serialized
    // process-wide, so a spawn-scoped timeout would silently mean
    // "queue wait + timeoutMs" and a caller waiting behind two other runs
    // could not tell a queue from a hung fence.
    const deadline = Date.now() + input.timeoutMs;

    return await runExclusive(async () => {
      if (disposed) {
        throw new FenceExecutorDisposedError();
      }
      // An abort has to be honoured WHILE QUEUED, not only once spawned:
      // pressing Stop behind two other runs must not wait for them.
      if (input.signal.aborted) {
        throw new ExecAbortedError({ processStarted: false });
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        // Nothing ran, so there is no honest ExecResult to return — the seam
        // forbids fabricating one for code that never executed.
        throw new FenceQueueTimeoutError(input.timeoutMs);
      }
      // A prior teardown that exceeded its confirmation window stays tracked.
      // Do not install another run's process-global policy while that group may
      // still be alive; a later call may proceed once ESRCH proves it is gone.
      assertNoSurvivingProcessGroups();
      // 0o600: this module does not own scratchDir, and a shared or
      // group-writable one would otherwise leave a window where another local
      // user can read or replace the script that is about to run.
      await writeFile(scriptPath, input.code, { encoding: 'utf8', mode: 0o600 });
      try {
        await applySessionConfig(config);
        const command = [interpreter.command, ...(interpreter.args ?? []), scriptPath]
          .map(shellQuote)
          .join(' ');
        const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
          command,
          undefined,
          config,
          undefined,
          input.scratchDir
        );
        return await spawnFenced({
          argv,
          cwd: input.scratchDir,
          env: buildSandboxEnv(env, interpreter.env),
          maxOutputBytes: input.maxOutputBytes,
          signal: input.signal,
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
      } finally {
        // Linux-only in effect (it clears bwrap mount points), but calling it
        // unconditionally keeps one code path and is a no-op elsewhere.
        SandboxManager.cleanupAfterCommand();
        await rm(scriptPath, { force: true });
      }
    });
  };

  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    await runExclusive(releaseSession);
  };

  return { capabilities, dispose, execute };
}

/**
 * OS/runtime gate for host wiring. A returned factory still awaits actual
 * readiness on every construction; presence alone is never evidence that the
 * host permits its sandbox. Unsupported hosts omit the capability entirely.
 */
export function createFenceExecutorFactory(
  options: FenceExecutorOptions
): CodeExecutorFactory | undefined {
  if (!isFenceSupported()) {
    return;
  }
  return (signal) => createFenceExecutor(options, signal);
}
