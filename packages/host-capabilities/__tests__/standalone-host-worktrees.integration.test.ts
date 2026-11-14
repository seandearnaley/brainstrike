/**
 * Through the trusted model seam, the standalone host reads the git worktrees
 * of its launch root and refuses to archive the one it was launched on.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_RESULT_SCHEMAS } from '@brainstrike/agent-host/protocol';
import { StateStore } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  cleanup,
  drainCleanup,
  recordedToolResults,
  standaloneHost,
  trustedPlatformModule,
} from './fixtures/standalone-trusted-host.ts';

afterEach(drainCleanup);

test('the standalone host lists the git worktrees of its launch root', {
  timeout: 120_000,
}, async () => {
  // listWorktrees is a deferred tool: the model loads it by name, then calls it.
  const module = await trustedPlatformModule('trusted-fixture', [
    { input: { toolName: 'brainstrike_listWorktrees' }, toolId: 'load_tool' },
    { input: {}, toolId: 'brainstrike_listWorktrees' },
  ]);
  const host = await standaloneHost({}, module, { 'README.md': 'repository\n' });
  const git = (cwd: string, ...args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile('git', args, { cwd }, (cause) => (cause ? reject(cause) : resolve()));
    });
  await git(host.workspace, 'init', '--quiet', '--initial-branch=main');
  await git(host.workspace, 'add', 'README.md');
  await git(
    host.workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'initial'
  );
  const sibling = `${host.workspace}-feature`;
  cleanup.push(() => rm(sibling, { force: true, recursive: true }));
  await git(host.workspace, 'worktree', 'add', '--quiet', '-b', 'feature-2386', sibling);
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const listed = await host.run('trusted-fixture::probe');
  expect(listed.result, listed.result.stderr).toMatchObject({ code: 0 });
  // The model sees both checkouts of the repository, read by this host's own git inventory.
  const result = recordedToolResults(listed.rows).find(
    ({ toolCallId }) => toolCallId === 'recorded-call-2'
  );
  const text = JSON.stringify(result?.output);
  expect(text).toContain(host.workspace);
  expect(text).toContain(sibling);
  expect(text).toContain('feature-2386');
});

test('the standalone host refuses to archive the worktree it was launched on', {
  timeout: 120_000,
}, async () => {
  const git = (cwd: string, ...args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile('git', args, { cwd }, (cause, stdout) => (cause ? reject(cause) : resolve(stdout)));
    });
  const repository = await realpath(await mkdtemp(join(tmpdir(), 'bs-launch-worktree-repo-')));
  cleanup.push(() => rm(repository, { force: true, recursive: true }));
  // manageWorktree is deferred and execute-risk: the model loads it, then the run asks.
  const module = await trustedPlatformModule('trusted-fixture', [
    { input: { toolName: 'brainstrike_manageWorktree' }, toolId: 'load_tool' },
    {
      input: { action: 'archive', force: true, worktreeId: 'launch-worktree' },
      toolId: 'brainstrike_manageWorktree',
    },
  ]);
  const host = await standaloneHost({}, module, {}, async ({ dataRoot, workspace }) => {
    await writeFile(join(repository, 'README.md'), 'repository\n');
    await git(repository, 'init', '--quiet', '--initial-branch=main');
    await git(repository, 'add', 'README.md');
    await git(
      repository,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'initial'
    );
    // The launch root is a managed worktree recorded in this host's own ledger.
    await git(repository, 'worktree', 'add', '--quiet', '-b', 'launch-2386', workspace);
    const store = await StateStore.open(dataRoot);
    try {
      await store.worktreeLedger({
        operation: 'insert',
        row: {
          archivedAt: null,
          archiveSnapshotRef: null,
          baseCommit: 'a'.repeat(40),
          baseRef: 'main',
          branch: 'launch-2386',
          createdAt: new Date().toISOString(),
          createdBy: 'user',
          id: 'launch-worktree',
          path: workspace,
          repoCommonDir: join(repository, '.git'),
          runId: null,
          setupOutput: null,
          setupReason: null,
          setupStatus: 'none',
          threadId: null,
        },
      });
    } finally {
      await store.close();
    }
  });
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const asked = await host.command([
    'run',
    'Archive this worktree.',
    '--model',
    'trusted-fixture::probe',
    '--json',
    '--non-interactive',
  ]);
  // A non-interactive run exits 2 at the approval it cannot answer.
  expect(asked.code, asked.stderr).toBe(2);
  const { runId, threadId } = z
    .object({ runId: z.string(), threadId: z.string() })
    .parse(JSON.parse(asked.stdout.split('\n')[0] || 'null'));
  const readRows = async () =>
    Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/read'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(JSON.parse((await host.command(['threads', 'show', '--thread', threadId])).stdout)).rows;
  const requested = (await readRows())
    .map((row) => row.event)
    .find((event) => event.type === 'interaction.requested');
  if (requested?.type !== 'interaction.requested') {
    throw new Error('The archive call asked for no approval');
  }
  const approved = await host.command([
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
  ]);
  expect(approved, approved.stderr).toMatchObject({ code: 0 });
  await expect
    .poll(async () => (await readRows()).some((row) => row.event.type === 'run.finished'), {
      timeout: 30_000,
    })
    .toBe(true);
  // The model is told why, and the checkout its run uses is still on disk and in git.
  const finished = (await readRows())
    .map((row) => row.event)
    .find((event) => event.type === 'effect.finished' && event.toolCallId === 'recorded-call-2');
  expect(JSON.stringify(finished)).toContain('a workspace root this host was launched on');
  await expect(readFile(join(host.workspace, 'README.md'), 'utf8')).resolves.toBe('repository\n');
  expect(await git(repository, 'worktree', 'list')).toContain(host.workspace);
});
