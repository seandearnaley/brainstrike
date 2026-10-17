import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_RESULT_SCHEMAS } from '@brainstrike/agent-host/protocol';
import { removeFixtureRoot } from '@brainstrike/agent-host/test-fixtures/cooperative-host';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';

const bin = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const httpFixture = new URL('./fixtures/standalone-production-http.mjs', import.meta.url).href;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
const EDIT = { content: 'written by the standalone host\n', path: 'notes.txt' };
function command(dataRoot: string, args: readonly string[]) {
  return new Promise<{
    code: number;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    execFile(
      process.execPath,
      [bin, '--data-root', dataRoot, ...args],
      {
        cwd: tmpdir(),
        env: {
          BRAINSTRIKE_M3_STANDALONE_EDIT: JSON.stringify(EDIT),
          BRAINSTRIKE_M3_STANDALONE_HTTP: 'edit',
          BRAINSTRIKE_M3_STANDALONE_RECEIPT: join(dataRoot, 'offline-receipt.jsonl'),
          BRAINSTRIKE_OPENAI_API_KEY: 'offline-standalone-fixture',
          LC_ALL: 'C',
          NODE_OPTIONS: `--import=${httpFixture}`,
          PATH: process.env['PATH'],
          SystemRoot: process.env['SystemRoot'],
          TZ: 'UTC',
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
async function rows(dataRoot: string, threadId: string) {
  const shown = await command(dataRoot, ['threads', 'show', '--thread', threadId]);
  expect(shown).toMatchObject({ code: 0, stderr: '' });
  return Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/read'], {
    errors: 'all',
    onExcessProperty: 'error',
  })(JSON.parse(shown.stdout)).rows;
}
test('the standalone CLI host runs the shared file tool over its --workspace launch root', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-standalone-native-data-'));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-standalone-native-ws-')));
  cleanup.push(async () => {
    await rm(workspace, { force: true, recursive: true });
    await removeFixtureRoot(dataRoot);
  });
  cleanup.push(async () => {
    const selected = RootLock.inspect(dataRoot)?.owner;
    if (selected && !selected.released) {
      const pid = decodeHostRecord(
        JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8'))
      ).pid;
      expect(await command(dataRoot, ['host', 'stop'])).toMatchObject({ code: 0 });
      await expect.poll(() => processStartTime(pid)).toBeNull();
    }
  });
  await writeFile(join(workspace, 'notes.txt'), 'original notes\n');
  expect(await command(dataRoot, ['host', 'start', '--workspace', workspace])).toMatchObject({
    code: 0,
    stderr: '',
  });
  // An attached host keeps its own launch roots.
  expect(await command(dataRoot, ['threads', 'list', '--workspace', tmpdir()])).toMatchObject({
    code: 1,
  });
  const paused = await command(dataRoot, [
    'run',
    'Rewrite the notes.',
    '--model',
    'openai::gpt-6-sol',
    '--json',
    '--non-interactive',
  ]);
  // The default `edit: ask` policy pauses the file write for approval.
  expect(paused.code, paused.stderr).toBe(2);
  const { runId, threadId } = z
    .object({ runId: z.string(), threadId: z.string() })
    .parse(JSON.parse(paused.stdout.split('\n')[0] ?? ''));
  const pausedRows = await rows(dataRoot, threadId);
  const requested = pausedRows.find((row) => row.event.type === 'interaction.requested')?.event;
  if (requested?.type !== 'interaction.requested') {
    throw new Error('The standalone file write did not pause for approval');
  }
  expect(requested).toMatchObject({ input: EDIT, toolId: 'brainstrike_writeWorkspaceFile' });
  expect(pausedRows.find((row) => row.event.type === 'run.started')?.event).toMatchObject({
    snapshot: {
      configuration: {
        workspaceRoots: [{ displayName: expect.any(String), path: workspace, rootId: workspace }],
      },
      toolIdentities: { brainstrike_writeWorkspaceFile: 'brainstrike.writeWorkspaceFile' },
    },
  });
  expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('original notes\n');
  expect(
    await command(dataRoot, [
      'interaction',
      'respond',
      '--thread',
      threadId,
      '--run',
      runId,
      '--interaction',
      requested.interactionId,
      '--decision',
      'approve',
    ])
  ).toMatchObject({ code: 0 });
  const attached = await command(dataRoot, [
    'attach',
    '--thread',
    threadId,
    '--run',
    runId,
    '--json',
    '--non-interactive',
  ]);
  expect(attached, attached.stderr).toMatchObject({ code: 0, stderr: '' });
  const finished = await rows(dataRoot, threadId);
  expect(finished.find((row) => row.event.type === 'run.finished')?.event).toMatchObject({
    outcome: 'completed',
  });
  expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe(EDIT.content);
  expect(finished.filter((row) => row.event.type === 'workspace.edit.recorded')).toEqual([
    expect.objectContaining({
      event: expect.objectContaining({
        op: 'write',
        path: 'notes.txt',
        rootId: workspace,
        rootPath: workspace,
        runId,
      }),
    }),
  ]);
});
