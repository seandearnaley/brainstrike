import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import {
  attachAgentHost,
  type HostLogRow,
  type HostPlatform,
  type HostTool,
  startAgentHost,
} from '@brainstrike/agent-host';
import {
  scriptedCursorPaging,
  scriptedToolResult,
} from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  createSharedNativeHostTools,
  ReadWorkspaceFileCursorRegistry,
} from '../src/native-tools/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const BIG = Array.from({ length: 3000 }, (_, line) => `line ${line} ${'z'.repeat(40)}`).join('\n');
const PageSchema = z.object({
  value: z.object({
    content: z.string(),
    endByte: z.number(),
    next: z.object({ input: z.object({ cursor: z.string() }), tool: z.string() }).optional(),
    offsetByte: z.number(),
  }),
});

test('the host executes the shared artifact reader over its committed output', async () => {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'bs-artifact-reader-data-')));
  cleanup.push(() => rm(dataRoot, { force: true, recursive: true }));
  const shared = createSharedNativeHostTools({
    ids: [NATIVE_TOOL_ID.readToolOutputArtifact],
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
    runtime: { model: 'scripted', provider: 'openai', workspaceRoots: [] },
  });
  const big: HostTool = {
    description: 'Return a large result',
    execute: async () => BIG,
    identity: 'big-fixture',
    inputSchema: z.object({}),
    permissionToolId: 'brainstrike.bigFixture',
    risk: 'read',
  };
  const prompts: Parameters<typeof scriptedToolResult>[0][] = [];
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: true }),
    resolveModel: async () => scriptedCursorPaging('big', prompts),
    tools: { ...shared, big },
  };
  const started = await startAgentHost({ lifetime: 'persistent', root: dataRoot }, platform);
  const client = await attachAgentHost(started.record);
  cleanup.push(async () => {
    await client.close();
    await started.close();
  });
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Page the big result',
    threadId,
  });
  let rows: readonly HostLogRow[] = [];
  await expect
    .poll(async () => {
      rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      return rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId);
    })
    .toBe(true);

  expect(rows.find((row) => row.event.type === 'run.finished')?.event).toMatchObject({
    outcome: 'completed',
  });
  const [first, page] = [
    PageSchema.parse(scriptedToolResult(prompts[1] ?? [], 'paging-call-1')),
    PageSchema.parse(scriptedToolResult(prompts[2] ?? [], 'paging-call-2')),
  ];
  // The model got the first page of the committed result and the shared reader's cursor.
  expect(first.value.offsetByte).toBe(0);
  expect(first.value.next?.tool).toBe(Object.keys(shared)[0]);
  // The shared reader continued exactly where the first page ended.
  expect(page.value.offsetByte).toBe(first.value.endByte);
  expect(BIG.slice(first.value.content.length).startsWith(page.value.content)).toBe(true);
});
