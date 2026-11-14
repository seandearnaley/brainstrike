/**
 * BST-2536: `threads compact` compacts a standalone host's thread between runs,
 * through its scripted trusted model, and prints the committed event.
 */
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  drainCleanup,
  standaloneHost,
  trustedPlatformModule,
} from './fixtures/standalone-trusted-host.ts';

afterEach(drainCleanup);

const SUMMARY = [
  'Goal: Say hello.',
  'Constraints: None.',
  'Decisions: None.',
  'Errors and fixes: None.',
  'State: Every note was read.',
  'Next: Answer.',
].join('\n');
const FOCUS = 'Keep the greeting.';
// Each longer than a read's 12,000 characters: about 3,000 estimated tokens a
// read, so the run's oldest reads lie behind its newest 20,000 tokens.
const NOTES = Array.from({ length: 10 }, (_unused, index) => `notes-${index + 1}.md`);

test('threads compact summarizes a thread’s older steps and prints the committed event', {
  timeout: 120_000,
}, async () => {
  const module = await trustedPlatformModule(
    'trusted-fixture',
    [
      { input: { toolName: 'brainstrike_readWorkspaceFile' }, toolId: 'load_tool' },
      ...NOTES.map((path) => ({ input: { path }, toolId: 'brainstrike_readWorkspaceFile' })),
    ],
    {},
    SUMMARY
  );
  const host = await standaloneHost(
    {},
    module,
    Object.fromEntries(NOTES.map((path) => [path, `${path}\n${'note '.repeat(3000)}\n`]))
  );
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const ran = await host.run('trusted-fixture::probe');
  expect(ran.result, ran.result.stderr).toMatchObject({ code: 0 });
  const { runId, threadId } = z
    .object({ runId: z.string(), threadId: z.string() })
    .parse(JSON.parse(ran.result.stdout.split('\n')[0] ?? 'null'));

  const compacted = await host.command([
    'threads',
    'compact',
    '--thread',
    threadId,
    '--focus',
    FOCUS,
    '--json',
  ]);
  expect(compacted, compacted.stderr).toMatchObject({ code: 0 });
  const event: unknown = JSON.parse(compacted.stdout);
  expect(event).toMatchObject({
    focus: FOCUS,
    kind: 'agentic',
    reason: 'requested',
    runId,
    summary: SUMMARY,
    through: { runId },
    type: 'context.compacted',
  });
  // The printed event is the one the thread committed.
  const rows = await host.threadRows(threadId);
  expect(
    rows.flatMap((row) => (row.event.type === 'context.compacted' ? [row.event] : []))
  ).toEqual([event]);

  // Everything droppable is summarized: a second request is refused, and commits nothing.
  const again = await host.command(['threads', 'compact', '--thread', threadId]);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain('Nothing in this thread can be compacted yet.');
  const after = await host.threadRows(threadId);
  expect(after.filter((row) => row.event.type === 'context.compacted')).toHaveLength(1);
});
