import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunAdmissionRequest } from '../src/ports.js';
import type { HostEvent, HostLogRow } from '../src/protocol.js';

type Started = Extract<HostEvent, { type: 'run.started' }>;
type Requested = Extract<HostEvent, { type: 'interaction.requested' }>;
type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const PLAN = {
  overview: 'Write the fixture once the plan is approved.',
  steps: [{ title: 'Write plan-approved.txt' }],
  title: 'Write the fixture',
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

function call(toolCallId: string, toolName: string, input: unknown): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { input: JSON.stringify(input), toolCallId, toolName, type: 'tool-call' },
    { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
  ];
}

function text(value: string): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { id: 'text-1', type: 'text-start' },
    { delta: value, id: 'text-1', type: 'text-delta' },
    { id: 'text-1', type: 'text-end' },
    { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
  ];
}

/**
 * A model that plans while it can only read, and writes once it can: it calls
 * submit_plan when no write tool is offered, write_file once one is, then answers.
 */
function planningModel(offered: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const tools = (options.tools ?? []).map((tool) => tool.name);
      offered.push(tools);
      const results = options.prompt
        .slice(options.prompt.findLastIndex((message) => message.role === 'user'))
        .flatMap((message) =>
          message.role === 'tool'
            ? message.content.filter((part) => part.type === 'tool-result')
            : []
        );
      const chunks = tools.includes('write_file')
        ? results.length === 0
          ? call('write-1', 'write_file', { text: 'implemented' })
          : text('Implemented the approved plan.')
        : results.length === 0
          ? call('plan-1', 'submit_plan', PLAN)
          : text('Revising the plan.');
      return {
        stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
      };
    },
  });
}

async function openHost(options: { readonly followUpFails?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-plan-mode-'));
  const store = await StateStore.open(root);
  const offered: string[][] = [];
  const requests: HostRunAdmissionRequest[] = [];
  const written: unknown[] = [];
  const planResume = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('approved'), feedback: z.string().optional() }),
    z.strictObject({ action: z.literal('rejected'), feedback: z.string() }),
  ]);
  const tools = {
    submit_plan: {
      description: 'Submit a plan for approval',
      execute: async (_input: unknown, context: { readonly resumeData?: unknown }) =>
        planResume.parse(context.resumeData),
      identity: 'submit-plan-generation-1',
      inputSchema: z.object({
        overview: z.string(),
        steps: z.array(z.object({ title: z.string() })),
        title: z.string(),
      }),
      interaction: { kind: 'plan' as const, resumeSchema: planResume },
      permissionToolId: 'brainstrike.submitPlan',
      risk: 'read' as const,
    },
    write_file: {
      description: 'Write an owned fixture',
      execute: async (input: unknown) => {
        written.push(input);
        return { written: true };
      },
      identity: 'write-file-generation-1',
      inputSchema: z.object({ text: z.string() }),
      permissionToolId: 'brainstrike.writeFixture',
      risk: 'edit' as const,
    },
  };
  const platform: HostPlatform = {
    admitRun: async (request) => {
      requests.push(request);
      if (options.followUpFails && !request.planMode) {
        throw new Error(options.followUpFails);
      }
      // A plan-mode admission offers only what plan mode keeps.
      const admitted = request.planMode ? { submit_plan: tools.submit_plan } : tools;
      return {
        configuration: {},
        model: planningModel(offered),
        snapshot: {
          configuration: {},
          maxSteps: 4,
          toolIdentities: Object.fromEntries(
            Object.entries(admitted).map(([id, tool]) => [id, tool.identity])
          ),
        },
        tools: admitted,
      };
    },
    close: async () => undefined,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'allow' },
      yolo: false,
    }),
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  return { core, offered, requests, threadId, written };
}

async function rowsUntil(
  core: HostCore,
  threadId: string,
  done: (rows: readonly HostLogRow[]) => boolean
): Promise<HostLogRow[]> {
  await expect.poll(async () => done(await core.read(threadId, 0))).toBe(true);
  return core.read(threadId, 0);
}

test('approving a plan finishes the plan run and continues in a follow-up run without plan mode', async () => {
  const { core, offered, requests, threadId, written } = await openHost();
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    planMode: true,
    prompt: 'Plan, then write the fixture.',
    threadId,
  });
  const pending = await rowsUntil(core, threadId, (rows) =>
    rows.some((row) => row.event.type === 'interaction.requested')
  );
  const request = pending.find((row) => row.event.type === 'interaction.requested')
    ?.event as Requested;
  expect(request).toMatchObject({ kind: 'plan', runId });
  expect(requests[0]).toMatchObject({ planMode: true });
  expect(offered[0]).toEqual(['submit_plan']);

  await core.resume({
    commandId: randomUUID(),
    interactionId: request.interactionId,
    resumeData: { action: 'approved' },
    runId,
    threadId,
  });
  const rows = await rowsUntil(
    core,
    threadId,
    (all) => all.filter((row) => row.event.type === 'run.finished').length === 2
  );
  const started = rows.flatMap((row) => (row.event.type === 'run.started' ? [row.event] : []));
  const finished = rows.flatMap((row) => (row.event.type === 'run.finished' ? [row.event] : []));
  expect(finished).toEqual([
    expect.objectContaining({ outcome: 'completed', runId }),
    expect.objectContaining({ outcome: 'completed', runId: started[1]?.runId }),
  ]);
  // The follow-up is the thread's next run: it follows the plan run, without plan mode.
  const followUp = started[1] as Started;
  expect(followUp.prompt).toBe('Approved the plan.');
  expect(followUp.planMode).toBeUndefined();
  expect(followUp.parentMessageId).toBe(runId);
  expect(requests[1]?.planMode).toBeUndefined();
  expect(written).toEqual([{ text: 'implemented' }]);
  // The plan run made no further model call once its plan was approved.
  expect(offered).toHaveLength(3);
  expect(offered[1]).toEqual(['submit_plan', 'write_file']);
});

test('rejecting a plan keeps its run in plan mode', async () => {
  const { core, offered, threadId, written } = await openHost();
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    planMode: true,
    prompt: 'Plan, then write the fixture.',
    threadId,
  });
  const pending = await rowsUntil(core, threadId, (rows) =>
    rows.some((row) => row.event.type === 'interaction.requested')
  );
  const request = pending.find((row) => row.event.type === 'interaction.requested')
    ?.event as Requested;
  await core.resume({
    commandId: randomUUID(),
    interactionId: request.interactionId,
    resumeData: { action: 'rejected', feedback: 'Write a smaller fixture.' },
    runId,
    threadId,
  });
  const rows = await rowsUntil(core, threadId, (all) =>
    all.some((row) => row.event.type === 'run.finished')
  );
  expect(rows.filter((row) => row.event.type === 'run.started')).toHaveLength(1);
  expect(offered).toEqual([['submit_plan'], ['submit_plan']]);
  expect(written).toEqual([]);
});

test('a follow-up run that cannot start is committed as the thread’s failed next run', async () => {
  const cause = 'The provider refused the follow-up admission';
  const { core, threadId } = await openHost({ followUpFails: cause });
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    planMode: true,
    prompt: 'Plan, then write the fixture.',
    threadId,
  });
  const pending = await rowsUntil(core, threadId, (rows) =>
    rows.some((row) => row.event.type === 'interaction.requested')
  );
  const request = pending.find((row) => row.event.type === 'interaction.requested')
    ?.event as Requested;
  await core.resume({
    commandId: randomUUID(),
    interactionId: request.interactionId,
    resumeData: { action: 'approved', feedback: 'Keep it short.' },
    runId,
    threadId,
  });
  const rows = await rowsUntil(
    core,
    threadId,
    (all) => all.filter((row) => row.event.type === 'run.finished').length === 2
  );
  const started = rows.flatMap((row) => (row.event.type === 'run.started' ? [row.event] : []));
  expect(started[1]).toMatchObject({
    parentMessageId: runId,
    prompt: 'Approved the plan.\n\nKeep it short.',
  });
  expect(rows.flatMap((row) => (row.event.type === 'run.finished' ? [row.event] : []))).toEqual([
    expect.objectContaining({ outcome: 'completed', runId }),
    expect.objectContaining({ detail: cause, outcome: 'failed', runId: started[1]?.runId }),
  ]);
});
