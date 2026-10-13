import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeFileMentionId,
  serializeFileMentionDirective,
} from '@brainstrike/assistant-contract';
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/workspace-text-file-reader';
import { afterEach, expect, test } from 'vitest';
import { readDesktopHostSystemContext } from '../agent-host-platform/desktop-host-context';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-reference-notices-')));
  directories.push(root);
  await writeFile(join(root, 'ok.txt'), 'SUCCESSFUL_REFERENCE_BODY');
  await symlink(
    join(root, '..', 'outside-missing-reference-target.txt'),
    join(root, 'dangling.txt')
  );
  return root;
}

test('the actual whole-file reader distinguishes missing from a dangling outside target', async () => {
  const rootPath = await fixture();
  await expect(
    readWorkspaceTextFile({ requestedPath: 'missing.txt', rootPath })
  ).rejects.toMatchObject({ reason: 'missing' });
  await expect(
    readWorkspaceTextFile({ requestedPath: 'dangling.txt', rootPath })
  ).rejects.toMatchObject({ reason: 'outside' });
});

test('one context read returns safe structured reference failures beside its model text', async () => {
  const root = await fixture();
  const prompt = ['missing.txt', 'dangling.txt', 'ok.txt']
    .map((path) =>
      serializeFileMentionDirective({ id: encodeFileMentionId('root-1', path), label: path })
    )
    .join(' ');
  const reads: string[] = [];
  const context = await readDesktopHostSystemContext({
    inputTokenLimit: 5000,
    planMode: false,
    readWorkspaceFile: (args) => {
      reads.push(args.requestedPath);
      return readWorkspaceTextFile(args);
    },
    request: {
      modelId: 'fake::model',
      prompt,
      signal: new AbortController().signal,
      threadId: 'thread-1',
    },
    runtime: {
      provider: 'openrouter',
      workspaceRoots: [{ displayName: 'repo', path: root, rootId: 'root-1' }],
    },
    tools: {},
  });
  expect(context).toMatchObject({
    referencedFileFailures: [
      {
        failure: { kind: 'refusal', message: 'Path "missing.txt" does not exist.' },
        path: 'missing.txt',
        rootId: 'root-1',
      },
      {
        failure: {
          kind: 'refusal',
          message: 'Path "dangling.txt" is outside the selected workspace root.',
        },
        path: 'dangling.txt',
        rootId: 'root-1',
      },
    ],
  });
  expect(context.system).toContain('SUCCESSFUL_REFERENCE_BODY');
  expect(context.system).toContain('Path "missing.txt" does not exist.');
  expect(context.system).toContain('Path "dangling.txt" is outside the selected workspace root.');
  expect(JSON.stringify(context)).not.toContain(join(root, 'missing.txt'));
  expect(JSON.stringify(context)).not.toContain(join(root, 'dangling.txt'));
  expect(JSON.stringify(context)).not.toContain('ENOENT');
  expect(reads.filter((path) => path === 'missing.txt')).toHaveLength(1);
  expect(reads.filter((path) => path === 'dangling.txt')).toHaveLength(1);
  expect(reads.filter((path) => path === 'ok.txt')).toHaveLength(1);
});
