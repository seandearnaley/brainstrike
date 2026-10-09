import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookManager, type HookRunEventInput } from '../../src/hooks/manager.js';
import type { HooksConfigLoadResult, LoadedHook } from '../../src/hooks/types.js';

let tmpRoot: string;

function makeHook(command: string, toolNameRegex?: RegExp): LoadedHook {
  return {
    definition: { command, type: 'command' },
    source: { cwd: tmpRoot, scope: 'global' },
    ...(toolNameRegex ? { toolNameRegex } : {}),
  };
}

const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

function makeManager(
  load: Partial<HooksConfigLoadResult>,
  events: HookRunEventInput[],
  aggregateTimeoutMs = 60_000
): HookManager {
  const full: HooksConfigLoadResult = {
    errors: load.errors ?? [],
    hooks: load.hooks ?? {},
    sources: load.sources ?? [],
  };
  return new HookManager(full, {
    aggregateTimeoutMs,
    emitRunEvent: (event) => events.push(event),
    logger,
    primaryCwd: tmpRoot,
    sessionId: 'session-1',
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bs-hooks-mgr-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpRoot, { force: true, recursive: true });
});

describe('HookManager', () => {
  it('reports each config error once as a hook.notice(failed)', () => {
    const events: HookRunEventInput[] = [];
    const manager = makeManager(
      {
        errors: [
          {
            message: 'bad',
            path: '/x/hooks.json',
            reason: 'invalid',
            rootId: 'r1',
            scope: 'project',
          },
        ],
      },
      events
    );

    manager.reportConfigErrors();
    manager.reportConfigErrors(); // second call must not re-emit

    const notices = events.filter((e) => e.kind === 'hook.notice' && e.status === 'failed');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail).toBe('/x/hooks.json: bad');
  });

  it('names Settings > Hooks for a project file that trusting would run', () => {
    const events: HookRunEventInput[] = [];
    makeManager(
      {
        errors: [
          {
            message: 'not trusted',
            path: '/x/hooks.json',
            reason: 'untrusted',
            rootId: 'r1',
            scope: 'project',
          },
        ],
      },
      events
    ).reportConfigErrors();
    expect(events[0]?.detail).toBe('/x/hooks.json: not trusted — review it in Settings > Hooks');
  });

  it('hasHooks reflects whether any event has hooks', () => {
    expect(makeManager({}, []).hasHooks()).toBe(false);
    expect(makeManager({ hooks: { PreToolUse: [makeHook('exit 0')] } }, []).hasHooks()).toBe(true);
  });

  it('runs a PreToolUse hook only for a matching tool name', async () => {
    const events: HookRunEventInput[] = [];
    const manager = makeManager(
      { hooks: { PreToolUse: [makeHook('exit 2', /^executeCommand$/)] } },
      events
    );

    const nonMatch = await manager.runPreToolUse('readFile', {});
    expect(nonMatch.allowed).toBe(true);
    expect(nonMatch.results).toHaveLength(0);

    const match = await manager.runPreToolUse('executeCommand', { cmd: 'ls' });
    expect(match.allowed).toBe(false);
    expect(events.some((e) => e.kind === 'hook.blocked')).toBe(true);
  });

  it('surfaces PostToolUse additionalContext as a hook.notice', async () => {
    const events: HookRunEventInput[] = [];
    const manager = makeManager(
      {
        hooks: {
          PostToolUse: [makeHook(`echo '{"additionalContext":"lint ok"}'`)],
        },
      },
      events
    );

    const result = await manager.runPostToolUse({
      toolError: false,
      toolInput: {},
      toolName: 'anyTool',
      toolOutput: { ok: true },
    });

    expect(result.allowed).toBe(true);
    expect(result.additionalContext).toBe('lint ok');
    expect(events.some((e) => e.kind === 'hook.notice' && /added context/.test(e.label))).toBe(
      true
    );
  });

  it('rejects a turn via a blocking UserPromptSubmit hook', async () => {
    const events: HookRunEventInput[] = [];
    const manager = makeManager(
      {
        hooks: {
          UserPromptSubmit: [makeHook(`echo '{"reason":"no"}'; exit 2`)],
        },
      },
      events
    );

    const result = await manager.runUserPromptSubmit('hi');
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('no');
    expect(events.some((e) => e.kind === 'hook.blocked')).toBe(true);
  });

  it('runs Stop hooks with the given reason (notify path)', async () => {
    const events: HookRunEventInput[] = [];
    const manager = makeManager({ hooks: { Stop: [makeHook('exit 0')] } }, events);

    const result = await manager.runStop('complete');
    expect(result.allowed).toBe(true);
    expect(result.results).toHaveLength(1);
  });

  it('bounds the Stop phase to the aggregate budget (finish delivery cannot stall)', async () => {
    // Stop runs in FRONT of the message-finish yield with the watchdog disarmed,
    // so an unbounded chain of slow Stop hooks would delay finish delivery. Two
    // 3s hooks with a 300ms aggregate must abandon the in-flight hook at the
    // budget, skip the rest, and surface a loud warning (warn-and-continue).
    const events: HookRunEventInput[] = [];
    const manager = makeManager(
      { hooks: { Stop: [makeHook('sleep 3'), makeHook('sleep 3')] } },
      events,
      300
    );

    const started = Date.now();
    const result = await manager.runStop('complete');
    const elapsed = Date.now() - started;

    expect(result.allowed).toBe(true);
    expect(elapsed).toBeLessThan(2000);
    expect(result.results).toHaveLength(1);
    expect(result.warnings.some((w) => /aggregate/i.test(w))).toBe(true);
    expect(events.some((e) => e.kind === 'hook.notice' && /aggregate/i.test(e.detail ?? ''))).toBe(
      true
    );
  });
});
