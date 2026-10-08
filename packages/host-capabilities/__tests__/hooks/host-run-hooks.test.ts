import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createHostRunHooks } from '../../src/hooks/host-run-hooks.js';

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
  });
  expect(hooks?.matchesPreToolUse('brainstrike.webSearch')).toBe(true);
  expect(hooks?.matchesPreToolUse('brainstrike.readWorkspaceFile')).toBe(false);
});
