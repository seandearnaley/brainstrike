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

function executeHook(hook: LoadedHook, stdin: HookStdin): Promise<HookResult> {
  const timeout = hook.definition.timeout ?? DEFAULT_HOOK_TIMEOUT_MS;
  const startTime = Date.now();
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd' : '/bin/sh';
  const shellArgs = isWindows ? ['/c', hook.definition.command] : ['-c', hook.definition.command];

  return new Promise<HookResult>((resolve) => {
    const child = spawn(shell, shellArgs, {
      cwd: hook.source.cwd,
      env: { ...process.env, BRAINSTRIKE_HOOK_EVENT: stdin.hook_event_name },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
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

  for (const hook of hooks) {
    const result = await executeHook(hook, buildStdin(hook));
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
