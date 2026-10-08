/**
 * Lifecycle hooks on the CLI host (the real production bin): a global
 * PreToolUse hook blocks a tool the policy would ask about, through the same
 * approval gate, and the block's reason is committed with the call.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_RESULT_SCHEMAS } from '@brainstrike/agent-host/protocol';
import { removeFixtureRoot } from '@brainstrike/agent-host/test-fixtures/cooperative-host';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';

const bin = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const httpFixture = new URL('./fixtures/standalone-production-http.mjs', import.meta.url).href;
const REASON = 'Questions are disabled in this workspace';
const cleanup: (() => Promise<void>)[] = [];

function command(dataRoot: string, home: string, args: readonly string[]) {
  return new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      [bin, '--data-root', dataRoot, ...args],
      {
        cwd: tmpdir(),
        env: {
          // The global hooks file is `$HOME/.brainstrike/hooks.json`.
          BRAINSTRIKE_M3_STANDALONE_HTTP: 'question',
          BRAINSTRIKE_M3_STANDALONE_RECEIPT: join(dataRoot, 'offline-receipt.jsonl'),
          BRAINSTRIKE_OPENAI_API_KEY: 'offline-standalone-fixture',
          HOME: home,
          LC_ALL: 'C',
          NODE_OPTIONS: `--import=${httpFixture}`,
          PATH: process.env['PATH'],
          SystemRoot: process.env['SystemRoot'],
          TZ: 'UTC',
          USERPROFILE: home,
        },
        timeout: 20_000,
        windowsHide: true,
      },
      (cause, stdout, stderr) => {
        if (!cause) {
          resolve({ code: 0, stderr, stdout });
        } else if (typeof cause.code === 'number') {
          resolve({ code: cause.code, stderr, stdout });
        } else {
          reject(cause);
        }
      }
    );
  });
}

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

test('a global PreToolUse hook blocks a tool on the CLI host, with its reason committed', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-host-hooks-'));
  const home = await mkdtemp(join(tmpdir(), 'bs-m3-host-hooks-home-'));
  cleanup.push(() => rm(home, { force: true, recursive: true }));
  cleanup.push(async () => {
    const owner = RootLock.inspect(dataRoot)?.owner;
    if (owner && !owner.released) {
      const record = decodeHostRecord(
        JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8'))
      );
      await command(dataRoot, home, ['host', 'stop']);
      await expect.poll(() => processStartTime(record.pid)).toBeNull();
    }
    await removeFixtureRoot(dataRoot);
  });
  await mkdir(join(home, '.brainstrike'));
  await writeFile(
    join(home, '.brainstrike', 'hooks.json'),
    JSON.stringify({
      PreToolUse: [
        {
          command: `echo '{"decision":"block","reason":"${REASON}"}'; exit 2`,
          matcher: { tool_name: 'askUser' },
          type: 'command',
        },
      ],
    })
  );
  expect(await command(dataRoot, home, ['host', 'start'])).toMatchObject({ code: 0, stderr: '' });
  const run = await command(dataRoot, home, [
    'run',
    'Use the recorded canonical human interaction.',
    '--model',
    'openai::gpt-6-sol',
    '--json',
    '--non-interactive',
  ]);
  // The blocked question is never asked: the run completes instead of pausing.
  expect(run.code, run.stderr).toBe(0);
  const { threadId } = z
    .object({ runId: z.string(), threadId: z.string() })
    .parse(JSON.parse(run.stdout.split('\n')[0] ?? ''));
  const shown = await command(dataRoot, home, ['threads', 'show', '--thread', threadId]);
  const { rows } = HOST_RESULT_SCHEMAS['thread/read'].parse(JSON.parse(shown.stdout));
  expect(rows.some(({ event }) => event.type === 'interaction.requested')).toBe(false);
  expect(rows.some(({ event }) => event.type === 'effect.started')).toBe(false);
  const responses = rows.flatMap(({ event }) =>
    event.type === 'stream.chunk' &&
    typeof event.chunk === 'object' &&
    event.chunk !== null &&
    !Array.isArray(event.chunk) &&
    event.chunk['type'] === 'tool-approval-response'
      ? [event.chunk]
      : []
  );
  expect(responses).toEqual([expect.objectContaining({ approved: false, reason: REASON })]);
});
