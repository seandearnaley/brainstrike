import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  type HostLogRow,
  type HostPlatform,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import {
  createSharedNativeHostTools,
  ReadWorkspaceFileCursorRegistry,
} from '../src/native-tools/index.js';

const ROOT_ID = 'shared-tools-root';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** The same composition every host uses: Core dispatches, the shared tools execute in-process. */
async function host(
  dataRoot: string,
  workspace: string,
  calls: readonly { readonly toolId: string; readonly input: unknown }[],
  freshRoots: () => void,
  ids: Parameters<typeof createSharedNativeHostTools>[0]['ids'] = [
    NATIVE_TOOL_ID.writeWorkspaceFile,
    NATIVE_TOOL_ID.manageTaskList,
    NATIVE_TOOL_ID.manageCanvas,
  ]
): Promise<{ client: HostClient; host: AgentHost }> {
  const roots = [{ displayName: 'workspace', path: workspace, rootId: ROOT_ID }];
  const tools = createSharedNativeHostTools({
    freshRoots: async () => {
      freshRoots();
      return roots;
    },
    ids,
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
    runtime: { model: 'scripted', provider: 'openai', workspaceRoots: roots },
  });
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 8,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: true }),
    resolveModel: async () =>
      scriptedToolSequence(
        calls.map((call) => ({ ...call, toolId: call.toolId.replace('.', '_') }))
      ),
    resolveWorkspaceRoot: async ({ rootId }) => {
      if (rootId !== ROOT_ID) {
        throw new Error('Unknown workspace root');
      }
      return workspace;
    },
    tools,
  };
  const started = await startAgentHost({ lifetime: 'persistent', root: dataRoot }, platform);
  const client = await attachAgentHost(started.record);
  cleanup.push(async () => {
    await client.close();
    await started.close();
  });
  return { client, host: started };
}

async function finished(client: HostClient, threadId: string, runId: string) {
  let rows: readonly HostLogRow[] = [];
  await expect
    .poll(async () => {
      rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      return rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId);
    })
    .toBe(true);
  return rows;
}

test('the shared native tools execute in the host: edits revert, task list and canvas live in the thread log', async () => {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'bs-shared-tools-data-')));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'bs-shared-tools-workspace-')));
  cleanup.push(async () => {
    await rm(dataRoot, { force: true, recursive: true });
    await rm(workspace, { force: true, recursive: true });
  });
  await writeFile(join(workspace, 'notes.txt'), 'original notes\n');
  let rootReads = 0;
  const calls = [
    {
      input: { content: 'rewritten notes\n', path: 'notes.txt' },
      toolId: NATIVE_TOOL_ID.writeWorkspaceFile,
    },
    {
      input: {
        tasks: [{ activeForm: 'Editing notes', content: 'Edit notes', status: 'in_progress' }],
      },
      toolId: NATIVE_TOOL_ID.manageTaskList,
    },
    {
      input: {
        action: 'create',
        html: '<!doctype html><html><body><p>Report</p></body></html>',
        title: 'Report',
      },
      toolId: NATIVE_TOOL_ID.manageCanvas,
    },
  ];
  let opened = await host(dataRoot, workspace, calls, () => {
    rootReads += 1;
  });
  const { threadId } = await opened.client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await opened.client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Edit the notes, plan, and report',
    threadId,
  });
  const rows = await finished(opened.client, threadId, runId);
  expect(rows.find((row) => row.event.type === 'run.finished')?.event).toMatchObject({
    outcome: 'completed',
  });
  expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('rewritten notes\n');
  // Every call revalidated the admitted roots before and after it ran.
  expect(rootReads).toBe(calls.length * 2);
  expect(rows.filter((row) => row.event.type === 'workspace.edit.recorded')).toEqual([
    expect.objectContaining({
      event: expect.objectContaining({ op: 'write', path: 'notes.txt', rootId: ROOT_ID }),
    }),
  ]);
  const state = rows.flatMap((row) =>
    row.event.type === 'tool.state.updated' ? [[row.event.key, row.event.value]] : []
  );
  expect(state).toEqual([
    [
      NATIVE_TOOL_ID.manageTaskList,
      [
        expect.objectContaining({
          content: 'Edit notes',
          id: expect.any(String),
          status: 'in_progress',
        }),
      ],
    ],
    [
      expect.stringMatching(/^brainstrike\.manageCanvas\//u),
      expect.objectContaining({ title: 'Report', version: 1 }),
    ],
  ]);

  // Restart, then a second run reads the committed task list and canvas back.
  await opened.client.close();
  await opened.host.close();
  cleanup.splice(-1, 1);
  const canvasKey = String(state[1]?.[0]);
  const canvasId = canvasKey.slice('brainstrike.manageCanvas/'.length);
  opened = await host(
    dataRoot,
    workspace,
    [
      {
        input: { action: 'update', canvasId, newString: 'Updated report', oldString: 'Report</p>' },
        toolId: NATIVE_TOOL_ID.manageCanvas,
      },
      { input: { action: 'list' }, toolId: NATIVE_TOOL_ID.manageCanvas },
    ],
    () => undefined
  );
  const second = await opened.client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Revise the report',
    threadId,
  });
  const after = await finished(opened.client, threadId, second.runId);
  const outputs = after.flatMap((row) =>
    row.event.type === 'effect.finished' && row.event.runId === second.runId
      ? [row.event.output]
      : []
  );
  expect(outputs).toEqual([
    { canvasId, version: 2 },
    {
      canvases: [expect.objectContaining({ canvasId, title: 'Report', version: 2 })],
      truncated: false,
    },
  ]);

  const reverted = await opened.client.request('checkpoint/revert', {
    commandId: randomUUID(),
    runId,
    threadId,
  });
  expect(reverted.outcomes).toEqual([expect.objectContaining({ status: 'reverted' })]);
  expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('original notes\n');
});

test('glob and symbol search run in the host over the admitted root', async () => {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'bs-shared-search-data-')));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'bs-shared-search-workspace-')));
  cleanup.push(async () => {
    await rm(dataRoot, { force: true, recursive: true });
    await rm(workspace, { force: true, recursive: true });
  });
  await mkdir(join(workspace, 'src'));
  await writeFile(
    join(workspace, 'src', 'server.ts'),
    'export function startServer(port: number) {\n  return port;\n}\n'
  );
  await writeFile(join(workspace, 'README.md'), 'notes\n');
  let rootReads = 0;
  const calls = [
    { input: { pattern: 'src/**/*.ts' }, toolId: NATIVE_TOOL_ID.globWorkspace },
    {
      input: { path: 'src/server.ts', query: 'startServer' },
      toolId: NATIVE_TOOL_ID.findWorkspaceSymbol,
    },
  ];
  const opened = await host(
    dataRoot,
    workspace,
    calls,
    () => {
      rootReads += 1;
    },
    [NATIVE_TOOL_ID.globWorkspace, NATIVE_TOOL_ID.findWorkspaceSymbol]
  );
  const { threadId } = await opened.client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await opened.client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Find the server entry point',
    threadId,
  });
  const rows = await finished(opened.client, threadId, runId);
  expect(rows.find((row) => row.event.type === 'run.finished')?.event).toMatchObject({
    outcome: 'completed',
  });
  expect(rootReads).toBe(calls.length * 2);
  const outputs = rows.flatMap((row) =>
    row.event.type === 'effect.finished' ? [row.event.output] : []
  );
  expect(outputs).toEqual([
    expect.objectContaining({
      matches: [expect.objectContaining({ path: '/src/server.ts', rootId: ROOT_ID })],
      totalMatches: 1,
    }),
    expect.objectContaining({
      matches: [expect.objectContaining({ declarationLine: 1, endLine: 3 })],
      path: 'src/server.ts',
      totalMatches: 1,
    }),
  ]);
});
