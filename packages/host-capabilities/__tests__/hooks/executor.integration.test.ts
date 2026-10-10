import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactSecrets, runHooksForEvent } from '../../src/hooks/executor.js';
import type { HookStdin, LoadedHook } from '../../src/hooks/types.js';
import { writeHookCommand, writeStdoutHook } from '../fixtures/native-hook-command.js';

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
      [makeLoadedHook(writeStdoutHook(tmpRoot, { reason: 'nope' }, 2))],
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
      [makeLoadedHook(writeHookCommand(tmpRoot, 'setTimeout(() => {}, 5000);'), { timeout: 50 })],
      () => toolStdin(),
      { blocking: true, logger }
    );
    expect(result.allowed).toBe(true);
    expect(result.results[0]?.timedOut).toBe(true);
    expect(result.warnings.some((w) => /timed out/i.test(w))).toBe(true);
  });

  // Privacy: docs/agents/platform-contracts.md forbids ever logging/persisting
  // command text. This branch's Flight Recorder P2a durable NDJSON backstop
  // mirrors every warn+ `logger.*` call to a plaintext file on disk, so a raw
  // `command` field here would have made a hook's command text durable and
  // greppable. Assert the logged payload carries only non-reversible metadata
  // (length + a hash prefix), never the command string itself.
  it('never logs raw command text on hook timeout — only length + fingerprint', async () => {
    const command = `${writeHookCommand(tmpRoot, 'setTimeout(() => {}, 5000);')} secret-looking-command-text`;
    await runHooksForEvent([makeLoadedHook(command, { timeout: 50 })], () => toolStdin(), {
      blocking: true,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'hook timed out',
      expect.objectContaining({
        commandLength: command.length,
        commandSha256Prefix: expect.any(String),
        timeoutMs: 50,
      })
    );
    const emittedPayloads = JSON.stringify(logger.warn.mock.calls);
    expect(emittedPayloads).not.toContain(command);
    expect(emittedPayloads).not.toContain('secret-looking-command-text');
  });

  it('never logs raw command text when a hook exits non-zero — only length + fingerprint', async () => {
    const command = `${writeHookCommand(tmpRoot, 'process.stdout.write("secret-looking-command-text\\n"); process.exitCode = 1;')} secret-looking-command-text`;
    await runHooksForEvent([makeLoadedHook(command)], () => toolStdin(), {
      blocking: true,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'hook exited non-zero',
      expect.objectContaining({
        commandLength: command.length,
        commandSha256Prefix: expect.any(String),
        exitCode: 1,
      })
    );
    const emittedPayloads = JSON.stringify(logger.warn.mock.calls);
    expect(emittedPayloads).not.toContain(command);
    expect(emittedPayloads).not.toContain('secret-looking-command-text');
  });

  it('bounds the whole phase to aggregateTimeoutMs (pre-stream backstop)', async () => {
    // Two long hooks; the aggregate budget is far below their per-hook default.
    // The phase must abandon the in-flight hook at the budget and skip the rest,
    // surfacing a loud warning and proceeding (timeout == warn-and-continue).
    const started = Date.now();
    const result = await runHooksForEvent(
      [
        makeLoadedHook(writeHookCommand(tmpRoot, 'setTimeout(() => {}, 5000);')),
        makeLoadedHook(writeHookCommand(tmpRoot, 'setTimeout(() => {}, 5000);')),
      ],
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
        makeLoadedHook(writeStdoutHook(tmpRoot, { additionalContext: 'a' })),
        makeLoadedHook(writeStdoutHook(tmpRoot, { additionalContext: 'b' })),
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
    const command = writeHookCommand(
      tmpRoot,
      `const { readFileSync, writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(outFile)}, readFileSync(0));\n`
    );

    const result = await runHooksForEvent(
      [makeLoadedHook(command)],
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

  it('does not expose provider credentials through the hook process environment', async () => {
    const priorCredential = process.env['OPENAI_API_KEY'];
    const priorOrdinaryValue = process.env['BRAINSTRIKE_HOOK_TEST_VALUE'];
    process.env['OPENAI_API_KEY'] = 'sentinel-provider-canary';
    process.env['BRAINSTRIKE_HOOK_TEST_VALUE'] = 'ordinary-value';

    try {
      const command = writeHookCommand(
        tmpRoot,
        'process.stdout.write(JSON.stringify({' +
          'credential:process.env.OPENAI_API_KEY??null,' +
          'event:process.env.BRAINSTRIKE_HOOK_EVENT??null,' +
          'ordinary:process.env.BRAINSTRIKE_HOOK_TEST_VALUE??null' +
          '}));'
      );
      const result = await runHooksForEvent([makeLoadedHook(command)], () => toolStdin(), {
        blocking: true,
        logger,
      });

      expect(result.results[0]?.stdout).toEqual({
        credential: null,
        event: 'PreToolUse',
        ordinary: 'ordinary-value',
      });
    } finally {
      if (priorCredential === undefined) {
        Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
      } else {
        process.env['OPENAI_API_KEY'] = priorCredential;
      }
      if (priorOrdinaryValue === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_HOOK_TEST_VALUE');
      } else {
        process.env['BRAINSTRIKE_HOOK_TEST_VALUE'] = priorOrdinaryValue;
      }
    }
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
    const hook = makeLoadedHook(
      writeHookCommand(
        tmpRoot,
        `require('node:fs').writeFileSync(${JSON.stringify(outFile)}, process.cwd());\n`
      )
    );
    const result = await runHooksForEvent([hook], () => toolStdin(), {
      blocking: false,
      logger,
    });
    expect(result.allowed).toBe(true);
    const { readFileSync: rf, realpathSync } = await import('node:fs');
    expect(rf(outFile, 'utf8').trim()).toBe(realpathSync(tmpRoot));
  });
});
