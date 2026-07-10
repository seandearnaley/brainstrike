/**
 * Tool-lifecycle hook execution (desktop / main-process only).
 *
 * Spawns each hook command in its source root's cwd, writes a SECRET-REDACTED
 * JSON payload to stdin, enforces a per-hook SIGKILL timeout, and interprets
 * the exit code authoritatively: `2` = hard block on a blocking event, other
 * non-zero = warn-and-continue, `0` = ok. Malformed stdout never throws — the
 * `decision` is ignored but the authoritative exit code still applies.
 */

import { spawn } from 'node:child_process';
import type { ScopedLogger } from '@brainstrike/utils';
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookEventResult,
  type HookResult,
  type HookStdin,
  type HookStdout,
  type LoadedHook,
} from './types';

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
function killHookTree(child: ReturnType<typeof spawn>): void {
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

function executeHook(
  hook: LoadedHook,
  stdin: HookStdin,
  timeoutOverrideMs?: number
): Promise<HookResult> {
  const timeout = timeoutOverrideMs ?? hook.definition.timeout ?? DEFAULT_HOOK_TIMEOUT_MS;
  const startTime = Date.now();
  const shell = isWindows ? 'cmd' : '/bin/sh';
  const shellArgs = isWindows ? ['/c', hook.definition.command] : ['-c', hook.definition.command];

  return new Promise<HookResult>((resolve) => {
    // The hook inherits the FULL parent `process.env` (plus the one marker
    // below). Secret redaction applies ONLY to the stdin JSON payload — it does
    // NOT extend to inherited env. Low-risk here because provider API keys live
    // in the encrypted keychain, never in the assistant-server process env.
    const child = spawn(shell, shellArgs, {
      cwd: hook.source.cwd,
      // POSIX: own process group so the timeout can group-kill the whole tree
      // (see killHookTree). Windows has no process groups here.
      detached: !isWindows,
      env: { ...process.env, BRAINSTRIKE_HOOK_EVENT: stdin.hook_event_name },
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
      resolve({
        exitCode: exitCode ?? 1,
        hook: hook.definition,
        ...(parsedStdout ? { stdout: parsedStdout } : {}),
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

    try {
      const redacted = redactSecrets(stdin);
      child.stdin?.write(JSON.stringify(redacted));
      child.stdin?.end();
    } catch {
      // stdin write failure — the process still runs to completion/timeout.
    }
  });
}

export interface RunHooksOptions {
  /**
   * Wall-clock ceiling for the WHOLE phase, enforced across all of the phase's
   * hooks. Set for the PRE-STREAM `UserPromptSubmit` gate (which runs before the
   * model is invoked and is therefore NOT covered by the stream inactivity
   * watchdog), so a chain of slow hooks cannot stall turn start unboundedly.
   * Undefined for in-stream phases (PreToolUse/PostToolUse/Stop), which rely on
   * the per-hook SIGKILL + the stream inactivity watchdog instead.
   */
  readonly aggregateTimeoutMs?: number;
  readonly blocking: boolean;
  readonly logger: HookLogger;
}

function blockReasonFor(hook: LoadedHook, result: HookResult): string {
  return (
    result.stdout?.reason ||
    result.stderr ||
    `Blocked by hook: ${hook.definition.description || hook.definition.command}`
  );
}

type HookOutcome =
  | { readonly kind: 'continue'; readonly warning?: string }
  | { readonly kind: 'block'; readonly reason: string };

/** Classify a single hook result into a continue/block outcome (+ optional warning). */
function classifyResult(hook: LoadedHook, result: HookResult, opts: RunHooksOptions): HookOutcome {
  if (result.timedOut) {
    const timeout = hook.definition.timeout ?? DEFAULT_HOOK_TIMEOUT_MS;
    opts.logger.warn('hook timed out', { command: hook.definition.command });
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
      command: hook.definition.command,
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

  const results: HookResult[] = [];
  const warnings: string[] = [];
  let additionalContext: string | undefined;
  const phaseStart = Date.now();

  for (const hook of hooks) {
    const budget = resolvePhaseBudget(hook, opts, phaseStart);
    if (budget.kind === 'exhausted') {
      opts.logger.warn('hook phase exceeded aggregate budget', {
        aggregateTimeoutMs: opts.aggregateTimeoutMs,
      });
      warnings.push(
        `Hooks exceeded the ${opts.aggregateTimeoutMs}ms aggregate budget; remaining hooks were skipped`
      );
      break;
    }
    const result = await executeHook(hook, buildStdin(hook), budget.timeoutOverrideMs);
    results.push(result);

    const extra = result.stdout?.additionalContext;
    if (extra) {
      additionalContext = additionalContext ? `${additionalContext}\n${extra}` : extra;
    }

    const outcome = classifyResult(hook, result, opts);
    if (outcome.kind === 'block') {
      return {
        allowed: false,
        blockReason: outcome.reason,
        ...(additionalContext ? { additionalContext } : {}),
        results,
        warnings,
      };
    }
    if (outcome.warning) {
      warnings.push(outcome.warning);
    }
  }

  return {
    allowed: true,
    ...(additionalContext ? { additionalContext } : {}),
    results,
    warnings,
  };
}
