import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createHostRunHooks, loadHostRunHooks } from '../../src/hooks/host-run-hooks.js';
import { windowsCommandEntry } from '../fixtures/windows-command-entry.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test('a run’s hooks say which tools a PreToolUse hook would run for', () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-host-run-hooks-'));
  roots.push(root);
  const globalPath = join(root, 'hooks.json');
  writeFileSync(
    globalPath,
    JSON.stringify({
      PreToolUse: [
        { command: 'exit 0', matcher: { tool_name: '^brainstrike\\.webSearch$' }, type: 'command' },
      ],
    })
  );
  const hooks = createHostRunHooks({
    globalPath,
    maxHookTimeoutMs: 30_000,
    roots: [],
    sessionId: 'thread-1',
    windowsCommandEntry,
  });
  expect(hooks?.matchesPreToolUse('brainstrike.webSearch')).toBe(true);
  expect(hooks?.matchesPreToolUse('brainstrike.readWorkspaceFile')).toBe(false);
});

test('a run whose only project hooks file is untrusted runs no hooks, and names the file it skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'bs-host-run-hooks-'));
  roots.push(root);
  mkdirSync(join(root, '.brainstrike'));
  const projectPath = join(root, '.brainstrike', 'hooks.json');
  writeFileSync(projectPath, JSON.stringify({ Stop: [{ command: 'exit 0', type: 'command' }] }));
  const loaded = loadHostRunHooks({
    globalPath: join(root, 'no-global.json'),
    maxHookTimeoutMs: 30_000,
    roots: [{ absPath: root, rootId: 'root-1' }],
    sessionId: 'thread-1',
    windowsCommandEntry,
  });
  expect(loaded.hooks).toBeUndefined();
  expect(loaded.skipped).toEqual([
    {
      detail: 'not trusted',
      path: projectPath,
      reason: 'untrusted',
      rootId: 'root-1',
      scope: 'project',
    },
  ]);
});

test.skipIf(process.platform === 'win32')(
  'the run’s abort ends a running hook at once and runs none of the hooks after it',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'bs-host-run-hooks-'));
    roots.push(root);
    const globalPath = join(root, 'hooks.json');
    const marker = join(root, 'second-hook-ran');
    writeFileSync(
      globalPath,
      JSON.stringify({
        PreToolUse: [
          { command: 'sleep 600', type: 'command' },
          { command: `touch '${marker}'`, type: 'command' },
        ],
      })
    );
    const hooks = createHostRunHooks({
      globalPath,
      maxHookTimeoutMs: 30_000,
      roots: [],
      sessionId: 'thread-1',
      windowsCommandEntry,
    });
    // No hook timeout can fire: only the abort can end the sleeping hook.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const controller = new AbortController();
      const verdict = hooks?.preToolUse({
        input: {},
        signal: controller.signal,
        toolName: 'brainstrike.webSearch',
      });
      controller.abort();
      await expect(verdict).resolves.toEqual({ blocked: false });
      expect(existsSync(marker)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  },
  10_000
);
