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

/** A run's hooks from one global hooks file, as the CLI and desktop hosts compose them. */
function hooksFrom(config: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'bs-host-run-lifecycle-'));
  roots.push(root);
  const globalPath = join(root, 'hooks.json');
  writeFileSync(globalPath, JSON.stringify(config));
  const hooks = createHostRunHooks({
    globalPath,
    maxHookTimeoutMs: 30_000,
    roots: [],
    sessionId: 'thread-1',
  });
  if (!hooks) {
    throw new Error('Expected configured hooks');
  }
  return hooks;
}

const command = (stdout: unknown, exit = 0) => ({
  command: `printf '%s\\n' '${JSON.stringify(stdout)}'; exit ${exit}`,
  type: 'command',
});

test('a UserPromptSubmit hook blocks a prompt with its reason, or adds context for the run', async () => {
  const blocking = hooksFrom({
    UserPromptSubmit: [command({ decision: 'block', reason: 'Notes are off limits' }, 2)],
  });
  expect(await blocking.userPromptSubmit('Read notes.txt')).toEqual({
    blocked: true,
    reason: 'Notes are off limits',
  });
  const adding = hooksFrom({ UserPromptSubmit: [command({ additionalContext: 'Be brief.' })] });
  expect(await adding.userPromptSubmit('Read notes.txt')).toEqual({
    additionalContext: 'Be brief.',
    blocked: false,
  });
});

test('a PostToolUse hook’s context for a tool result is bounded', async () => {
  const hooks = hooksFrom({
    PostToolUse: [
      { ...command({ additionalContext: 'x'.repeat(2100) }), matcher: { tool_name: 'readFile' } },
    ],
  });
  const post = await hooks.postToolUse({
    error: false,
    input: { path: 'notes.txt' },
    output: { content: 'text' },
    toolName: 'brainstrike.readFile',
  });
  expect(Array.from(post.additionalContext ?? '')).toHaveLength(2000);
  expect(post.additionalContext?.endsWith('…')).toBe(true);
});

test('a Stop hook’s verdict line labels the run', async () => {
  const hooks = hooksFrom({
    Stop: [command({ brainstrikeRunVerdict: { detail: 'Graded', verdict: 'succeeded' } })],
  });
  expect(await hooks.stop({ assistantMessage: 'Done.', reason: 'complete' })).toEqual({
    verdict: { detail: 'Graded', verdict: 'succeeded' },
  });
});
