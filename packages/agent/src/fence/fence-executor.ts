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

/** How long to wait for the stdio pipes to close after the root process exits. */
const DRAIN_AFTER_EXIT_MS = 250;

/**
 * The binary that runs a language's script. Supplied by the host (BST-1061
 * owns resolving the bundled CPython), so this module never guesses a path.
 */
export interface FenceInterpreter {
  readonly args?: readonly string[];
  readonly command: string;
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
      rejectPromise(error);
    });

    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // 'close' waits for every pipe holder; a surviving grandchild can keep
      // stdout open forever. Give the pipes a short drain window, then take
      // the group down and report the status we already have.
      later(DRAIN_AFTER_EXIT_MS, () => {
        if (child.pid !== undefined) {
          killTree(child.pid, 'SIGKILL');
        }
        finish();
      });
    });

    child.on('close', finish);

    const { pid } = child;
    if (pid === undefined) {
      // spawn() failed to produce a pid; the 'error' handler settles this.
      return;
    }

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
    throw new Error(
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
      throw new Error(
        `timeoutMs must be a positive finite number of milliseconds; received ${JSON.stringify(input.timeoutMs)}.`
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

    return await runExclusive(async () => {
      if (disposed) {
        throw new FenceExecutorDisposedError();
      }
      await writeFile(scriptPath, input.code, 'utf8');
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
        return await spawnFenced(argv, env, input.scratchDir, input.timeoutMs);
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
