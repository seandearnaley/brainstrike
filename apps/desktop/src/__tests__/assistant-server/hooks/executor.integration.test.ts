import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactSecrets, runHooksForEvent } from '../../../assistant-server/hooks/executor';
import type { HookStdin, LoadedHook } from '../../../assistant-server/hooks/types';

let tmpRoot: string;

function makeLoadedHook(command: string, extra?: Partial<LoadedHook['definition']>): LoadedHook {
  return {
    definition: { command, type: 'command', ...extra },
    source: { cwd: tmpRoot, scope: 'global' },
  };
}

function toolStdin(overrides?: Partial<HookStdin>): HookStdin {
  return {
    cwd: tmpRoot,
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_input: { cmd: 'ls' },
    tool_name: 'executeCommand',
    ...(overrides as Record<string, unknown>),
  } as HookStdin;
}

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bs-hooks-exec-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpRoot, { force: true, recursive: true });
});

describe('redactSecrets', () => {
  it('redacts secret-bearing keys recursively', () => {
    const redacted = redactSecrets({
      apiKey: 'sk-123',
      list: [{ password: 'p' }],
      nested: { ok: 'keep', token: 'abc' },
    });
    expect(redacted).toEqual({
      apiKey: '[REDACTED]',
      list: [{ password: '[REDACTED]' }],
      nested: { ok: 'keep', token: '[REDACTED]' },
    });
  });
});

describe('runHooksForEvent', () => {
  it('allows when a hook exits 0', async () => {
    const result = await runHooksForEvent([makeLoadedHook('exit 0')], () => toolStdin(), {
      blocking: true,
      logger,
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks on exit 2 for a blocking event and reads reason from stdout', async () => {
    const result = await runHooksForEvent(
      [makeLoadedHook(`echo '{"reason":"nope"}'; exit 2`)],
      () => toolStdin(),
      { blocking: true, logger }
    );
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('nope');
  });

  it('does NOT block on exit 2 for a non-blocking event (warn only)', async () => {
    const result = await runHooksForEvent([makeLoadedHook('exit 2')], () => toolStdin(), {
      blocking: false,
      logger,
    });
    expect(result.allowed).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('warns and continues on exit 1', async () => {
    const result = await runHooksForEvent([makeLoadedHook('exit 1')], () => toolStdin(), {
      blocking: true,
      logger,
    });
    expect(result.allowed).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('SIGKILLs a hook that exceeds its timeout, warns, and does not hang', async () => {
    const result = await runHooksForEvent(
      [makeLoadedHook('sleep 5', { timeout: 50 })],
      () => toolStdin(),
      { blocking: true, logger }
    );
    expect(result.allowed).toBe(true);
    expect(result.results[0]?.timedOut).toBe(true);
    expect(result.warnings.some((w) => /timed out/i.test(w))).toBe(true);
  });

  it('bounds the whole phase to aggregateTimeoutMs (pre-stream backstop)', async () => {
    // Two long hooks; the aggregate budget is far below their per-hook default.
    // The phase must abandon the in-flight hook at the budget and skip the rest,
    // surfacing a loud warning and proceeding (timeout == warn-and-continue).
    const started = Date.now();
    const result = await runHooksForEvent(
      [makeLoadedHook('sleep 5'), makeLoadedHook('sleep 5')],
      () => toolStdin(),
      { aggregateTimeoutMs: 200, blocking: true, logger }
    );
    const elapsed = Date.now() - started;

    expect(result.allowed).toBe(true);
    expect(elapsed).toBeLessThan(2000);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.timedOut).toBe(true);
    expect(result.warnings.some((w) => /aggregate/i.test(w))).toBe(true);
  });

  it('aggregates additionalContext from every hook stdout', async () => {
    const result = await runHooksForEvent(
      [
        makeLoadedHook(`echo '{"additionalContext":"a"}'`),
        makeLoadedHook(`echo '{"additionalContext":"b"}'`),
      ],
      () => toolStdin(),
      { blocking: false, logger }
    );
    expect(result.additionalContext).toBe('a\nb');
  });

  it('ignores malformed stdout without throwing', async () => {
    const result = await runHooksForEvent([makeLoadedHook('echo not-json')], () => toolStdin(), {
      blocking: true,
      logger,
    });
    expect(result.allowed).toBe(true);
  });

  it('redacts secret-bearing stdin fields before the hook sees them', async () => {
    const outFile = join(tmpRoot, 'stdin-capture.json');
    const script = join(tmpRoot, 'capture.sh');
    writeFileSync(script, `#!/bin/sh\ncat > "${outFile}"\n`, 'utf8');
    chmodSync(script, 0o755);

    const result = await runHooksForEvent(
      [makeLoadedHook(`sh "${script}"`)],
      () =>
        toolStdin({
          tool_input: { apiKey: 'sk-secret', cmd: 'ls' },
        } as Partial<HookStdin>),
      { blocking: true, logger }
    );

    expect(result.allowed).toBe(true);
    const { readFileSync: rf } = await import('node:fs');
    const captured = JSON.parse(rf(outFile, 'utf8')) as {
      tool_input: { apiKey: string; cmd: string };
    };
    expect(captured.tool_input.apiKey).toBe('[REDACTED]');
    expect(captured.tool_input.cmd).toBe('ls');
  });

  it('does not crash the process when a hook exits before a large stdin payload flushes', async () => {
    // Regression: `child.stdin.write` emits its failure ASYNCHRONOUSLY on the
    // stream (an `'error'` event), which the surrounding synchronous try/catch
    // cannot see. A payload larger than the OS pipe buffer (~64KB) cannot flush
    // before a fast-exiting hook closes its stdin read end, so the write hits
    // `EPIPE`. Without an `'error'` listener on `child.stdin`, Node escalates it
    // to an `uncaughtException` that fails the whole Vitest run (observed only
    // under coverage timing). This asserts no such exception escapes.
    const captured: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      captured.push(error);
    };
    const priorHandlers = process.listeners('uncaughtException');
    for (const handler of priorHandlers) {
      process.removeListener('uncaughtException', handler);
    }
    process.on('uncaughtException', onUncaught);
    try {
      const huge = 'x'.repeat(1_000_000);
      const result = await runHooksForEvent(
        [makeLoadedHook('exit 0')],
        () => toolStdin({ tool_input: { blob: huge } } as Partial<HookStdin>),
        { blocking: true, logger }
      );
      // Let the async stdin `'error'` (if unhandled) propagate to uncaughtException.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(result.allowed).toBe(true);
      expect(captured).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      for (const handler of priorHandlers) {
        process.on('uncaughtException', handler as (error: Error) => void);
      }
    }
  });

  it('uses each hook source cwd for the spawn', async () => {
    const outFile = join(tmpRoot, 'pwd.txt');
    const hook = makeLoadedHook(`pwd > "${outFile}"`);
    const result = await runHooksForEvent([hook], () => toolStdin(), {
      blocking: false,
      logger,
    });
    expect(result.allowed).toBe(true);
    const { readFileSync: rf, realpathSync } = await import('node:fs');
    expect(rf(outFile, 'utf8').trim()).toBe(realpathSync(tmpRoot));
  });
});
