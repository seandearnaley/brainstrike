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
import { constants } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

import type {
  CodeExecutor,
  CodeExecutorFactory,
  ExecInput,
  ExecLanguage,
  ExecPlatform,
  ExecResult,
  ExecutorCapabilities,
} from '../code-execution';
import { buildSandboxRuntimeConfig } from './fence-policy';

/**
 * Per-stream capture cap. 1 MiB is far above any sane tool-output budget (the
 * model projection in docs/agents/assistant-providers.md clips much smaller)
 * while staying small enough that a runaway loop cannot exhaust memory. Output
 * beyond the cap is dropped and `truncated` is set — the stream keeps draining
 * so the sandboxed process never blocks on a full pipe.
 */
export const FENCE_MAX_STREAM_BYTES = 1024 * 1024;

/** Grace period between the SIGTERM and the SIGKILL sent to the process tree. */
const KILL_GRACE_MS = 500;

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

export class FenceUnsupportedPlatformError extends Error {
  readonly code = 'fence_unsupported_platform' as const;

  constructor(hostPlatform: string) {
    super(
      `The OS fence requires macOS (Seatbelt) or Linux (bubblewrap); this host reports '${hostPlatform}'. The host must not offer a fence factory here.`
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

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

/** POSIX single-quote escaping — srt embeds the command in a `sh -c` string. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid = the whole process group. `detached: true` made the child
    // the group leader, so every descendant it spawned is in this group.
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone. Nothing to kill.
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

function registerExitReaper(): void {
  if (exitReaperRegistered) {
    return;
  }
  exitReaperRegistered = true;
  process.once('exit', () => {
    for (const pid of liveProcessGroups) {
      killTree(pid, 'SIGKILL');
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
function buildSandboxEnv(
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

function toExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) {
    return code;
  }
  if (signal) {
    const signalNumber: number | undefined = constants.signals[signal];
    return typeof signalNumber === 'number' ? 128 + signalNumber : 1;
  }
  return 1;
}

interface StreamCapture {
  push(chunk: Buffer): void;
  text(): string;
  truncated: boolean;
}

function createStreamCapture(): StreamCapture {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const capture: StreamCapture = {
    push(chunk: Buffer): void {
      if (bytes >= FENCE_MAX_STREAM_BYTES) {
        capture.truncated = true;
        return;
      }
      const remaining = FENCE_MAX_STREAM_BYTES - bytes;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytes = FENCE_MAX_STREAM_BYTES;
        capture.truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: false,
  };
  return capture;
}

interface SpawnOutcome {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

function spawnFenced(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolvePromise, rejectPromise) => {
    const [command, ...args] = argv;
    if (!command) {
      rejectPromise(new Error('sandbox-runtime returned an empty command vector.'));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      detached: true,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = createStreamCapture();
    const stderr = createStreamCapture();
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

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

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      // Tear the group down BEFORE settling, on every path. A descendant that
      // detached its stdio closes our pipes while still running, which fires
      // 'close' early — settling there would clear the pending SIGKILL and
      // return with the descendant alive, free to outlive the policy this run
      // was granted. Killing here means no exit path can leak the group.
      if (child.pid !== undefined) {
        killTree(child.pid, 'SIGKILL');
        liveProcessGroups.delete(child.pid);
      }
      resolvePromise({
        exitCode: toExitCode(exitCode, exitSignal),
        stderr: stderr.text(),
        stdout: stdout.text(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      if (child.pid !== undefined) {
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
    registerExitReaper();
    liveProcessGroups.add(pid);

    later(timeoutMs, () => {
      timedOut = true;
      killTree(pid, 'SIGTERM');
      later(KILL_GRACE_MS, () => {
        killTree(pid, 'SIGKILL');
        // Hard backstop: if even SIGKILL leaves a pipe holder we cannot see,
        // report the timeout rather than hang the tool call forever.
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
export function createFenceExecutor(options: FenceExecutorOptions): CodeExecutor {
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
  activeSessions += 1;

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
    if (!(Number.isFinite(input.timeoutMs) && input.timeoutMs > 0)) {
      throw new FenceInvalidRequestError(
        `timeoutMs must be a positive finite number of milliseconds; received ${JSON.stringify(input.timeoutMs)}. The fence never runs code unbounded.`
      );
    }
    const interpreter = options.interpreters[input.language];
    if (!interpreter) {
      throw new FenceUnsupportedLanguageError(input.language, languages);
    }

    // Throws on a policy the fence cannot honour (e.g. an allowRead that would
    // re-open a credential store) before anything is spawned.
    const config = buildSandboxRuntimeConfig(input.policy, input.scratchDir);
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
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        // Nothing ran, so there is no honest ExecResult to return — the seam
        // forbids fabricating one for code that never executed.
        throw new FenceQueueTimeoutError(input.timeoutMs);
      }
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
        return await spawnFenced(
          argv,
          buildSandboxEnv(env, interpreter.env),
          input.scratchDir,
          Math.max(1, deadline - Date.now())
        );
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
    await runExclusive(async () => {
      activeSessions -= 1;
      if (activeSessions === 0 && sessionInitialized) {
        sessionInitialized = false;
        await SandboxManager.reset();
      }
    });
  };

  return { capabilities, dispose, execute };
}

/**
 * Capability probe for host wiring: a factory on a host that can fence,
 * `undefined` on one that cannot. Absence is the signal — the host omits the
 * `fence` capability and the seam refuses the mode instead of degrading it.
 */
export function createFenceExecutorFactory(
  options: FenceExecutorOptions
): CodeExecutorFactory | undefined {
  if (!isFenceSupported()) {
    return;
  }
  return () => createFenceExecutor(options);
}
