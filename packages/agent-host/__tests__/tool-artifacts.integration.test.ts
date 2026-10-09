import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiKeyAuthInput, type RuntimeData } from '@brainstrike/agent/provider-runtime';
import {
  projectToolOutputArtifactPage,
  readToolOutputArtifact,
  resolveScaledToolResultBudget,
  TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES,
} from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostTool } from '../src/ports.js';
import { createProductionHostPlatform } from '../src/production-platform.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedCursorPaging, scriptedToolResult } from '../src/test-fixtures/scripted-model.js';

const candidate = join(import.meta.dirname, '../../..');
const provider = 'openai';
const modelId = 'gpt-6-sol';
const BIG = Array.from({ length: 3000 }, (_, line) => `line ${line} ${'z'.repeat(40)}`).join('\n');

/** Mirrors the shared host executor: the legacy reader over Core's scoped reader. */
const reader: HostTool = {
  description: 'Read the next page of a durable tool output',
  execute: async (input, context) => {
    if (!context.artifacts) {
      throw new Error('Core supplied no artifact reader');
    }
    return await readToolOutputArtifact(
      { ...z.object({ cursor: z.string() }).parse(input), mode: 'cursor' },
      { reader: context.artifacts }
    );
  },
  identity: 'reader-fixture',
  inputSchema: z.object({ cursor: z.string() }),
  permissionToolId: NATIVE_TOOL_ID.readToolOutputArtifact,
  risk: 'read',
  toModelOutput: ({ output }) =>
    projectToolOutputArtifactPage(output, 30_000, 'reader') as ReturnType<
      NonNullable<HostTool['toModelOutput']>
    >,
};

const big: HostTool = {
  description: 'Return a large result',
  execute: async () => BIG,
  identity: 'big-fixture',
  inputSchema: z.object({}),
  permissionToolId: 'brainstrike.bigFixture',
  risk: 'read',
};

test('an oversized tool result reaches the model as a durable artifact page it can page from the committed output', async () => {
  expect(new TextEncoder().encode(BIG).byteLength).toBeGreaterThan(
    TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES
  );
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-tool-artifacts-'));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: join(
      candidate,
      'packages/agent-host/dist/adapters/memory-storage-calculator.js'
    ),
  });
  let core: HostCore | undefined;
  onTestFinished(async () => {
    await core?.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const prompts: Parameters<typeof scriptedToolResult>[0][] = [];
  const model = scriptedCursorPaging('big', prompts);
  const configuration: RuntimeData = { model: modelId, provider };
  const platform = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async () => ({
      configuration,
      durableConfiguration: { model: modelId, provider },
      maxSteps: 3,
      memory: {
        native: {
          options: {
            lastMessages: 200,
            observationalMemory: false,
            semanticRecall: false,
            workingMemory: { enabled: false },
          },
        },
        recordPrompt: async () => undefined,
        resourceId: 'm3-tool-artifacts-fixture',
      },
      providerRequestContext: { inputTokenLimit: 100_000, provider, runtimeData: configuration },
      resolvedToolResultBudget: resolveScaledToolResultBudget(100_000),
      tools: { big, reader },
      toolTimeoutMs: 5000,
    }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => model,
    resolveProviderAuth: async () => apiKeyAuthInput('offline-artifact-fixture-key'),
    startup: { register: async () => undefined, signal: new AbortController().signal, store },
  });
  core = await HostCore.open(store, platform, () => () => undefined);
  const opened = core;
  const { threadId } = await opened.startThread({ commandId: randomUUID() });
  const finished = Promise.withResolvers<void>();
  const unsubscribe = opened.onCommitted((row) => {
    if (row.threadId === threadId && row.event.type === 'run.finished') {
      finished.resolve();
    }
  });
  await opened.startRun({ commandId: randomUUID(), modelId, prompt: 'Page it', threadId });
  await finished.promise;
  unsubscribe();
  const events: HostEvent[] = (await opened.read(threadId, 0)).map((row) => row.event);

  expect(events.at(-1)).toMatchObject({ outcome: 'completed', type: 'run.finished' });
  // The complete result is the committed effect output.
  expect(events).toContainEqual(
    expect.objectContaining({ output: BIG, toolCallId: 'paging-call-1', type: 'effect.finished' })
  );
  // The model got the first page and a cursor, not the whole result.
  const first = z
    .object({
      value: z.object({ content: z.string(), endByte: z.number(), offsetByte: z.number() }),
    })
    .parse(scriptedToolResult(prompts[1] ?? [], 'paging-call-1'));
  expect(first.value.offsetByte).toBe(0);
  expect(BIG.startsWith(first.value.content)).toBe(true);
  expect(JSON.stringify(prompts[1]).length).toBeLessThan(BIG.length);
  // The reader's page continues exactly where the first page ended.
  const page = z
    .object({ value: z.object({ content: z.string(), offsetByte: z.number() }) })
    .parse(scriptedToolResult(prompts[2] ?? [], 'paging-call-2'));
  expect(page.value.offsetByte).toBe(first.value.endByte);
  expect(BIG.slice(first.value.content.length).startsWith(page.value.content)).toBe(true);
});
