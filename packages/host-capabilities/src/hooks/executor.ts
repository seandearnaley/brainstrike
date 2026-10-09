/**
 * Tool-lifecycle hook execution (desktop / main-process only).
 *
 * Spawns each hook command in its source root's cwd, writes a SECRET-REDACTED
 * JSON payload to stdin, enforces a per-hook SIGKILL timeout, and interprets
 * the exit code authoritatively: `2` = hard block on a blocking event, other
 * non-zero = warn-and-continue, `0` = ok. Malformed stdout never throws — the
 * `decision` is ignored but the authoritative exit code still applies.
 */

import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createCredentialIsolatedChildEnvironment } from '@brainstrike/assistant-contract/credential-child-environment';
import type { ScopedLogger } from '@brainstrike/logging';
import { spawnNativeChild } from '@brainstrike/state-store/native-children';
import { type HookRunVerdict, scanStdoutForRunVerdict } from './run-verdict.js';
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookEventResult,
  type HookResult,
  type HookStdin,
  type HookStdout,
  type LoadedHook,
} from './types.js';

type HookLogger = Pick<ScopedLogger, 'debug' | 'info' | 'warn' | 'error'>;

const REDACTED = '[REDACTED]';
/** Mirrors the logger redact key set; substring match covers compound keys. */
const SECRET_KEY_PATTERNS: readonly string[] = [
  'apikey',
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
];

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Recursively replace secret-bearing values with `[REDACTED]`. Exported for the
 * paired test. Non-plain values (Date etc.) are passed through structurally.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redactSecrets(inner);
    }
    return out;
  }
  return value;
}

function parseStdout(stdout: string): HookStdout | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as HookStdout;
    }
  } catch {
    // Malformed stdout: not a throw. The caller records a warning; the exit
    // code stays authoritative.
  }
  return;
}

const isWindows = process.platform === 'win32';

/**
 * SIGKILL the hook and EVERY process it spawned. Killing only the shell
 * (`child.kill`) leaves a grandchild (e.g. the `sleep` in `sh -c 'sleep 5'`,
 * when the shell forks rather than exec's it) orphaned — and because that
 * grandchild inherited the shell's stdout/stderr pipe fds, Node's `'close'`
 * event does NOT fire until the orphan itself exits, defeating the timeout
 * bound entirely. On POSIX the child is spawned `detached` (its own process
 * group), so `process.kill(-pid)` signals the whole group; the orphan dies and
 * the pipes close immediately.
 */
function killHookTree(child: ChildProcess): void {
  if (isWindows || typeof child.pid !== 'number') {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Group already gone (raced with normal exit) or unsignalable — fall back
    // to the direct child so we never leave the timer's kill un-attempted.
    child.kill('SIGKILL');
  }
}

interface ExecuteHookOptions {
  /** Scan raw stdout for a `brainstrikeRunVerdict` line (Stop phase only). */
  readonly captureRunVerdict?: boolean;
  readonly timeoutOverrideMs?: number;
}

function executeHook(
  hook: LoadedHook,
  stdin: HookStdin,
  logger: HookLogger,
  options: ExecuteHookOptions = {}
): Promise<HookResult> {
  const timeout = options.timeoutOverrideMs ?? hook.definition.timeout ?? DEFAULT_HOOK_TIMEOUT_MS;
  const startTime = Date.now();
  const shell = isWindows ? 'cmd' : '/bin/sh';
  const shellArgs = isWindows ? ['/c', hook.definition.command] : ['-c', hook.definition.command];

  return new Promise<HookResult>((resolve) => {
    // Hooks need ordinary shell/runtime variables, but repository-controlled
    // commands must never inherit provider credentials resolved into the
    // privileged Desktop main-process environment.
    const childEnvironment = createCredentialIsolatedChildEnvironment(process.env);
    const strippedCredentialCount =
      Object.keys(process.env).length - Object.keys(childEnvironment).length;
    if (strippedCredentialCount > 0) {
      logger.debug('hook environment removed provider credentials', {
        strippedCredentialCount,
      });
    }
    // In the agent host the hook inherits the Root's flock (ADR-0017).
    const child = spawnNativeChild(shell, shellArgs, {
      cwd: hook.source.cwd,
      // POSIX: own process group so the timeout can group-kill the whole tree
      // (see killHookTree). Windows has no process groups here.
      detached: !isWindows,
      env: {
        ...childEnvironment,
        BRAINSTRIKE_HOOK_EVENT: stdin.hook_event_name,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killHookTree(child);
    }, timeout);
    timer.unref?.();

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      const parsedStdout = parseStdout(stdout);
      // Verdict lines are scanned from the RAW stdout (the decision protocol
      // above parses the whole trimmed stdout as one JSON object, which a test
      // runner's mixed output never is). Bounded + strict — see run-verdict.ts.
      const verdictScan = options.captureRunVerdict ? scanStdoutForRunVerdict(stdout) : undefined;
      resolve({
        exitCode: exitCode ?? 1,
        hook: hook.definition,
        ...(parsedStdout ? { stdout: parsedStdout } : {}),
        ...(verdictScan?.verdict ? { runVerdict: verdictScan.verdict } : {}),
        ...(verdictScan && verdictScan.warnings.length > 0
          ? { runVerdictWarnings: verdictScan.warnings }
          : {}),
        ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
        durationMs: Date.now() - startTime,
        timedOut,
      });
    });

    child.on('error', (error: Error) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        durationMs: Date.now() - startTime,
        exitCode: 1,
        hook: hook.definition,
        stderr: error.message,
        timedOut: false,
      });
    });

    // A hook that exits without consuming stdin (e.g. `exit 0`) closes its read
    // end before our write flushes, so the write fails with EPIPE. Stream write
    // failures surface ASYNCHRONOUSLY as an `'error'` event — the synchronous
    // try/catch below cannot see them, and without this listener Node escalates
    // the error to an `uncaughtException` that crashes the process. Delivering
    // stdin is best-effort by design; the process still runs to completion or
    // timeout, so we log and continue rather than fail the hook.
    child.stdin?.on('error', (error: Error) => {
      logger.debug('hook stdin write failed', {
        command: hook.definition.command,
        error: error.message,
      });
    });
    try {
      const redacted = redactSecrets(stdin);
      child.stdin?.write(JSON.stringify(redacted));
      child.stdin?.end();
    } catch (error) {
      // Synchronous stdin failure (e.g. an already-destroyed stream). Async
      // failures are handled by the `'error'` listener above.
      logger.debug('hook stdin write threw synchronously', {
        command: hook.definition.command,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export interface RunHooksOptions {
  /**
   * Wall-clock ceiling for the WHOLE phase, enforced across all of the phase's
   * hooks. Set for the two phases that gate a user-visible boundary the stream
   * inactivity watchdog cannot reach: the PRE-STREAM `UserPromptSubmit` gate
   * (runs before the model is invoked) and the terminal `Stop` phase (runs in
   * FRONT of the `message-finish` yield — the watchdog is applied UPSTREAM of the
   * Stop seam and its timer is disarmed while Stop awaits). Without this cap an
   * unbounded chain of slow hooks would stall turn start / finish delivery. The
   * remaining in-stream phases (PreToolUse/PostToolUse) run WHILE the watchdog is
   * armed, so they rely on the per-hook SIGKILL + the watchdog instead and leave
   * this undefined.
   */
  readonly aggregateTimeoutMs?: number;
  readonly blocking: boolean;
  /**
   * Scan each hook's raw stdout for a strict `brainstrikeRunVerdict` line and
   * surface the phase's effective verdict on the event result (last valid hook
   * wins). Only the run-scoped Stop phase sets this — a tool-scoped phase must
   * never label the run.
   */
  readonly captureRunVerdict?: boolean;
  readonly logger: HookLogger;
}

function blockReasonFor(hook: LoadedHook, result: HookResult): string {
  return (
    result.stdout?.reason ||
    result.stderr ||
    `Blocked by hook: ${hook.definition.description || hook.definition.command}`
  );
}

/** Non-reversible fingerprint for a hook command, for warn+ logs: this branch
 * (Flight Recorder P2a) makes every warn+ log durable — mirrored into a
 * plaintext NDJSON file on disk (`error-log-sink.ts`) — so the raw command
 * text can no longer appear here (`docs/agents/platform-contracts.md`:
 * "Never log or persist command text, cwd, environment, or retained
 * output"). Length + a short sha256 prefix is still enough to correlate
 * repeated occurrences of "the same hook" across log lines without
 * reconstructing what the command actually was. */
function fingerprintCommand(command: string): {
  commandLength: number;
  commandSha256Prefix: string;
} {
  return {
    commandLength: command.length,
    commandSha256Prefix: createHash('sha256').update(command).digest('hex').slice(0, 12),
  };
}

type HookOutcome =
  | { readonly kind: 'continue'; readonly warning?: string }
  | { readonly kind: 'block'; readonly reason: string };

/** Classify a single hook result into a continue/block outcome (+ optional warning). */
function classifyResult(hook: LoadedHook, result: HookResult, opts: RunHooksOptions): HookOutcome {
  if (result.timedOut) {
    const timeout = hook.definition.timeout ?? DEFAULT_HOOK_TIMEOUT_MS;
    opts.logger.warn('hook timed out', {
      ...fingerprintCommand(hook.definition.command),
      ...(hook.definition.matcher?.tool_name === undefined
        ? {}
        : { matcher: hook.definition.matcher.tool_name }),
      timeoutMs: timeout,
    });
    return {
      kind: 'continue',
      warning: `Hook timed out after ${timeout}ms: ${hook.definition.command}`,
    };
  }
  if (result.exitCode === 2 && opts.blocking) {
    const reason = blockReasonFor(hook, result);
    opts.logger.info('hook blocked event', { reason });
    return { kind: 'block', reason };
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr || `Hook exited with code ${result.exitCode}`;
    opts.logger.warn('hook exited non-zero', {
      ...fingerprintCommand(hook.definition.command),
      exitCode: result.exitCode,
    });
    return {
      kind: 'continue',
      warning: `${hook.definition.description || hook.definition.command}: ${detail}`,
    };
  }
  return { kind: 'continue' };
}

/**
 * Resolve the aggregate-budget position for the next hook: `exhausted` (stop the
 * phase) or a `run` decision carrying the effective per-hook timeout cap. Capping
 * the in-flight hook at the remaining budget lets the existing per-hook SIGKILL
 * timer enforce the aggregate ceiling — no extra abort plumbing needed.
 */
function resolvePhaseBudget(
  hook: LoadedHook,
  opts: RunHooksOptions,
  phaseStart: number
): { readonly kind: 'exhausted' } | { readonly kind: 'run'; readonly timeoutOverrideMs?: number } {
  if (opts.aggregateTimeoutMs === undefined) {
    return { kind: 'run' };
  }
  const remaining = opts.aggregateTimeoutMs - (Date.now() - phaseStart);
  if (remaining <= 0) {
    return { kind: 'exhausted' };
  }
  return {
    kind: 'run',
    timeoutOverrideMs: Math.min(hook.definition.timeout ?? DEFAULT_HOOK_TIMEOUT_MS, remaining),
  };
}

export async function runHooksForEvent(
  hooks: readonly LoadedHook[],
  buildStdin: (hook: LoadedHook) => HookStdin,
  opts: RunHooksOptions
): Promise<HookEventResult> {
  if (hooks.length === 0) {
    return { allowed: true, results: [], warnings: [] };
  }

  const acc: PhaseAccumulator = { results: [], warnings: [] };
  const phaseStart = Date.now();

  for (const hook of hooks) {
    const budget = resolvePhaseBudget(hook, opts, phaseStart);
    if (budget.kind === 'exhausted') {
      opts.logger.warn('hook phase exceeded aggregate budget', {
        aggregateTimeoutMs: opts.aggregateTimeoutMs,
      });
      acc.warnings.push(
        `Hooks exceeded the ${opts.aggregateTimeoutMs}ms aggregate budget; remaining hooks were skipped`
      );
      break;
    }
    const result = await executeHook(hook, buildStdin(hook), opts.logger, {
      captureRunVerdict: opts.captureRunVerdict === true,
      ...(budget.timeoutOverrideMs === undefined
        ? {}
        : { timeoutOverrideMs: budget.timeoutOverrideMs }),
    });
    absorbHookResult(acc, result);

    const outcome = classifyResult(hook, result, opts);
    if (outcome.kind === 'block') {
      return phaseEventResult(acc, outcome.reason);
    }
    if (outcome.warning) {
      acc.warnings.push(outcome.warning);
    }
  }

  return phaseEventResult(acc);
}

/** Mutable per-phase aggregation over the executed hooks' results. */
interface PhaseAccumulator {
  additionalContext?: string;
  readonly results: HookResult[];
  runVerdict?: HookRunVerdict;
  readonly warnings: string[];
}

/** Fold one hook result into the phase accumulator (context, verdict, warnings). */
function absorbHookResult(acc: PhaseAccumulator, result: HookResult): void {
  acc.results.push(result);
  const extra = result.stdout?.additionalContext;
  if (extra) {
    acc.additionalContext = acc.additionalContext ? `${acc.additionalContext}\n${extra}` : extra;
  }
  if (result.runVerdictWarnings) {
    acc.warnings.push(...result.runVerdictWarnings);
  }
  if (result.runVerdict) {
    // Last valid verdict across the phase's hooks wins (documented).
    acc.runVerdict = result.runVerdict;
  }
}

/** Shape the accumulator as the phase result (blocked when a reason is given). */
function phaseEventResult(acc: PhaseAccumulator, blockReason?: string): HookEventResult {
  return {
    allowed: blockReason === undefined,
    ...(blockReason === undefined ? {} : { blockReason }),
    ...(acc.additionalContext ? { additionalContext: acc.additionalContext } : {}),
    results: acc.results,
    ...(acc.runVerdict ? { runVerdict: acc.runVerdict } : {}),
    warnings: acc.warnings,
  };
}
