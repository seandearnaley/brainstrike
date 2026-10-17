import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgentHost, attachAgentHost, startAgentHost } from '@brainstrike/agent-host';
import {
  CliWorkspaceRunInputSchema,
  materializeCliWorkspaceIntent,
  revalidateCliWorkspaceRoots,
  STANDALONE_WORKSPACE_CAPABILITY_ERROR,
  selectCliWorkspaceRoots,
} from '@brainstrike/agent-host/standalone-workspace-input';
import { removeFixtureRoot } from '@brainstrike/agent-host/test-fixtures/cooperative-host';
import {
  DEFAULT_PERMISSION_POLICIES,
  deriveSkillPreferenceKey,
} from '@brainstrike/assistant-contract';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';

const bin = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const offline = new URL('./fixtures/standalone-production-workspace-http.mjs', import.meta.url)
  .href;
const roots: string[] = [];
const hosts: AgentHost[] = [];
const ReceiptSchema = z.strictObject({
  electron: z.null(),
  event: z.literal('process-start'),
  isMainThread: z.boolean(),
  pid: z.number().int().positive(),
});
async function receipts(root: string) {
  return (await readFile(join(root, 'workspace-boundary.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => ReceiptSchema.parse(JSON.parse(line)));
}
function command(root: string, args: readonly string[]) {
  return new Promise<{
    code: number;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    execFile(
      process.execPath,
      [bin, '--data-root', root, ...args],
      {
        cwd: tmpdir(),
        env: {
          BRAINSTRIKE_M3_WORKSPACE_RECEIPT: join(root, 'workspace-boundary.jsonl'),
          LC_ALL: 'C',
          NODE_OPTIONS: `--import=${offline}`,
          PATH: process.env['PATH'],
          SystemRoot: process.env['SystemRoot'],
          TEMP: process.env['TEMP'],
          TMP: process.env['TMP'],
          TZ: 'UTC',
        },
        timeout: 10_000,
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
  for (const host of hosts.splice(0)) {
    await host.close();
  }
  for (const root of roots.splice(0)) {
    const owner = RootLock.inspect(root)?.owner;
    if (owner) {
      await expect.poll(() => RootLock.inspect(root)?.owner.released).toBe(true);
      if (owner.pid !== process.pid) {
        await expect.poll(() => processStartTime(owner.pid)).toBeNull();
      }
    }
    await removeFixtureRoot(root);
  }
});
test.each(['run', 'run start'])(
  'tracked bin submits workspace input to its existing owner (%s)',
  async (operation) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-input-'));
    roots.push(root);
    const received: unknown[] = [];
    // Admission observation only: no native executor, model or workspace authority
    // is faked or advertised. Actual Core owns authentication and the run command.
    const host = await startAgentHost(
      { lifetime: 'persistent', root },
      {
        admitRun: async (request) => {
          received.push(request.configuration);
          throw new Error('Fixture admission deliberately refuses execution');
        },
        close: async () => undefined,
        readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      }
    );
    hosts.push(host);
    const client = await attachAgentHost(host.record);
    const { threadId } = await client.request('thread/start', { commandId: 'workspace-thread' });
    await client.close();
    const result = await command(root, [
      ...operation.split(' '),
      '--thread',
      threadId,
      '--model',
      'openai::gpt-6-sol',
      '--prompt',
      'Inspect the selected workspace.',
      '--workspace-root',
      'owned-root',
      '--workspace-root',
      'other-owned-root',
      '--workspace-instructions',
      'off',
      '--skills',
      'off',
    ]);
    expect(received).toEqual([
      {
        kind: 'cli-workspace',
        version: 1,
        workspace: {
          instructions: 'off',
          rootIds: ['owned-root', 'other-owned-root'],
          skills: 'off',
        },
      },
    ]);
    expect(result.code).toBe(1);
    expect(RootLock.inspect(root)?.owner.pid).toBe(host.record.pid);
    expect(await receipts(root)).toEqual([
      { electron: null, event: 'process-start', isMainThread: true, pid: expect.any(Number) },
    ]);
  }
);
test('cold production bin refuses workspace admission before credentials or HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-input-'));
  roots.push(root);
  const result = await command(root, [
    'run',
    '--model',
    'openai::gpt-6-sol',
    '--prompt',
    'Inspect.',
    '--workspace-root',
    'ungranted-root',
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(STANDALONE_WORKSPACE_CAPABILITY_ERROR);
  expect(result.stderr).toContain('Attach to the desktop host');
  await expect.poll(() => RootLock.inspect(root)?.owner.released).toBe(true);
  const rows = await receipts(root);
  expect(rows.filter((row) => row.isMainThread)).toHaveLength(2);
  expect(
    rows
      .filter((row) => !row.isMainThread)
      .every((row) => row.pid === RootLock.inspect(root)?.owner.pid)
  ).toBe(true);
  expect(rows).toEqual(
    rows.map((row) => ({
      electron: null,
      event: 'process-start',
      isMainThread: row.isMainThread,
      pid: expect.any(Number),
    }))
  );
});
test.each(
  [
    ['--workspace-root', 'owned-root', '--workspace-root', 'owned-root'],
    ['--workspace-instructions', 'on'],
    ['--skills', 'on'],
  ].map((options) => ({ options }))
)('strict bin input refuses before Root acquisition (%j)', async ({ options }) => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-input-'));
  roots.push(root);
  const result = await command(root, [
    'run',
    '--model',
    'openai::gpt-6-sol',
    '--prompt',
    'Inspect.',
    ...options,
  ]);
  expect(result.code).toBe(1);
  expect(RootLock.inspect(root)).toBeNull();
});
const selected = {
  instructions: 'inherit' as const,
  rootIds: ['owned-root'],
  skills: 'off' as const,
};
const firstRoot = {
  displayName: 'Owned workspace',
  path: '/owner/workspace',
  rootId: 'owned-root',
};
const ownerRoots = [
  firstRoot,
  { displayName: 'Other workspace', path: '/owner/other', rootId: 'other-owned-root' },
];
const ownerIntent = {
  enabledNativeToolIds: ['brainstrike.readWorkspaceFile', 'brainstrike.writeWorkspaceFile'],
  modelConfiguration: { model: 'gpt-6-sol', provider: 'openai' },
  permissionPolicy: {
    perToolOverrides: { 'brainstrike.writeWorkspaceFile': 'deny' },
    policies: DEFAULT_PERMISSION_POLICIES,
    yolo: false,
  },
  selectionFolderId: 'other-owned-root',
  skillsPreference: {
    disabledSkillKeys: [deriveSkillPreferenceKey({ name: 'disabled', sourceRootId: 'owned-root' })],
    masterEnabled: false,
  },
  workspaceContext: {
    files: [
      { path: 'notes.txt', rootId: 'owned-root' },
      { path: 'other.txt', rootId: 'other-owned-root' },
      { path: 'unqualified.txt' },
    ],
  },
  workspaceInstructionsPreference: {
    masterEnabled: false,
    oversizedOptInByRootId: { 'other-owned-root': true, 'owned-root': true },
  },
};
test('per-run materialization reduces owner context while preserving model and denial policy, and drops retired checked files', () => {
  const materialized = materializeCliWorkspaceIntent(ownerIntent, selected);
  expect(materialized).toMatchObject({
    cliWorkspace: selected,
    enabledNativeToolIds: ownerIntent.enabledNativeToolIds,
    modelConfiguration: ownerIntent.modelConfiguration,
    permissionPolicy: ownerIntent.permissionPolicy,
    skillsPreference: ownerIntent.skillsPreference,
    workspaceInstructionsPreference: {
      masterEnabled: false,
      oversizedOptInByRootId: { 'owned-root': true },
    },
  });
  expect(materialized).not.toHaveProperty('selectionFolderId');
  // Checked files are not context (BST-2019): an older owner intent's never reaches a CLI run.
  expect(materialized).not.toHaveProperty('workspaceContext');
  expect(ownerIntent.selectionFolderId).toBe('other-owned-root');
  expect(
    materializeCliWorkspaceIntent(ownerIntent, { ...selected, skills: 'inherit' }).skillsPreference
      ?.masterEnabled
  ).toBe(false);
  const optionalOwner = materializeCliWorkspaceIntent(
    {
      ...ownerIntent,
      cliWorkspace: undefined,
      selectionFolderId: undefined,
      skillsPreference: undefined,
    },
    selected
  );
  expect(optionalOwner).not.toHaveProperty('selectionFolderId');
  expect(optionalOwner.skillsPreference?.masterEnabled).toBe(false);
});
test('live canonical roots authorize selection; captured observations only restrict fresh reads', () => {
  const captured = selectCliWorkspaceRoots(ownerRoots, selected);
  expect(captured).toEqual([firstRoot]);
  expect(selectCliWorkspaceRoots(ownerRoots, { ...selected, rootIds: [] })).toEqual([]);
  expect(() =>
    selectCliWorkspaceRoots(ownerRoots, { ...selected, rootIds: ['/owner/workspace'] })
  ).toThrow();
  expect(() => selectCliWorkspaceRoots([], selected)).toThrow();
  expect(() => revalidateCliWorkspaceRoots(captured, [], selected)).toThrow();
  expect(() =>
    revalidateCliWorkspaceRoots(captured, [{ ...firstRoot, path: '/replacement' }], selected)
  ).toThrow();
  expect(
    revalidateCliWorkspaceRoots(
      captured,
      [...ownerRoots, { displayName: 'New', path: '/new', rootId: 'new-root' }],
      selected
    )
  ).toEqual(captured);
  expect(() =>
    materializeCliWorkspaceIntent(
      { ...ownerIntent, cliWorkspace: selected },
      { ...selected, rootIds: ['other-owned-root'] }
    )
  ).toThrow();
});
test.each([
  'workspaceRootPath',
  'homeDir',
  'roots',
  'system',
  'modelConfiguration',
  'permissionPolicy',
  'snapshot',
])('strict envelope refuses client authority field %s', (field) => {
  expect(
    Schema.decodeUnknownResult(CliWorkspaceRunInputSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })({
      kind: 'cli-workspace',
      version: 1,
      workspace: selected,
      [field]: 'untrusted',
    })._tag === 'Success'
  ).toBe(false);
  expect(
    Schema.decodeUnknownResult(CliWorkspaceRunInputSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })({
      kind: 'cli-workspace',
      version: 1,
      workspace: { ...selected, [field]: 'untrusted' },
    })._tag === 'Success'
  ).toBe(false);
});
