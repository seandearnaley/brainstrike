import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiKeyAuthInput, type RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import {
  DEFAULT_PERMISSION_POLICIES,
  NATIVE_TOOL_ID,
  type PermissionToolGateSnapshot,
} from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import type { MockLanguageModelV4 } from 'ai/test';
import { expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostTool } from '../src/ports.js';
import { createProductionHostPlatform } from '../src/production-platform.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedToolSequence } from '../src/test-fixtures/scripted-model.js';

const candidate = join(import.meta.dirname, '../../..');
const provider = 'openai';
const modelId = 'gpt-6-sol';
/** A deferred native tool (loading tier `deferred`), under its sanitized provider name. */
const DEFERRED = NATIVE_TOOL_ID.listWorktrees.replace('.', '_');
const EAGER = 'eager_fixture';
const FIRST_STEP = [EAGER, 'list_available_tools', 'load_tool', 'search_tools'].sort();

const tools: Record<string, HostTool> = {
  [DEFERRED]: {
    description:
      'List every git worktree the workspace knows about: path, branch, whether BrainStrike manages it, whether it is usable, and if not, why. Read-only.',
    execute: async () => ({ worktrees: [] }),
    identity: 'deferred-fixture',
    inputSchema: z.object({}),
    permissionToolId: NATIVE_TOOL_ID.listWorktrees,
    risk: 'read',
  },
  [EAGER]: {
    description: 'An eager local tool',
    execute: async () => 'eager',
    identity: 'eager-fixture',
    inputSchema: z.object({}),
    risk: 'read',
  },
};

/** The tool names one provider request offered the model. */
function offered(model: MockLanguageModelV4, request: number): string[] {
  return (model.doStreamCalls[request]?.tools ?? []).map((tool) => tool.name).sort();
}

/** A started Core on the production platform; each run takes the next scripted model. */
async function discoveryHost(
  models: MockLanguageModelV4[],
  policy: PermissionToolGateSnapshot
): Promise<{ run(prompt: string, parentMessageId?: string | null): Promise<HostEvent[]> }> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-tool-discovery-'));
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
  const configuration: RuntimeData = { model: modelId, provider };
  const platform = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async () => ({
      configuration,
      durableConfiguration: { model: modelId, provider },
      maxSteps: 5,
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
        resourceId: 'm3-tool-discovery-fixture',
      },
      providerRequestContext: { inputTokenLimit: 100_000, provider, runtimeData: configuration },
      resolvedToolResultBudget: resolveScaledToolResultBudget(100_000),
      tools,
      toolTimeoutMs: 5000,
    }),
    readPermissionPolicy: () => policy,
    resolveModel: async () => {
      const next = models.shift();
      if (!next) {
        throw new Error('No scripted model left for this run');
      }
      return next;
    },
    resolveProviderAuth: async () => apiKeyAuthInput('offline-discovery-fixture-key'),
    startup: { register: async () => undefined, signal: new AbortController().signal, store },
  });
  core = await HostCore.open(store, platform, () => () => undefined);
  const opened = core;
  const { threadId } = await opened.startThread({ commandId: randomUUID() });
  return {
    // The run's rows once it finished, or once it paused for the user.
    run: async (prompt, parentMessageId) => {
      const settled = Promise.withResolvers<void>();
      const unsubscribe = opened.onCommitted((row) => {
        if (
          row.threadId === threadId &&
          (row.event.type === 'run.finished' || row.event.type === 'interaction.requested')
        ) {
          settled.resolve();
        }
      });
      const { runId } = await opened.startRun({
        commandId: randomUUID(),
        modelId,
        ...(parentMessageId === undefined ? {} : { parentMessageId }),
        prompt,
        threadId,
      });
      await settled.promise;
      unsubscribe();
      return (await opened.read(threadId, 0))
        .map((row) => row.event)
        .filter((event) => 'runId' in event && event.runId === runId);
    },
  };
}

test('a deferred tool reaches the model only after load_tool, and stays offered on its branch', async () => {
  const discovering = scriptedToolSequence([
    { input: { query: 'git worktree' }, toolId: 'search_tools' },
    { input: { toolName: DEFERRED }, toolId: 'load_tool' },
    { input: {}, toolId: DEFERRED },
  ]);
  const loading = scriptedToolSequence([
    { input: { toolName: DEFERRED }, toolId: 'load_tool' },
    { input: {}, toolId: DEFERRED },
  ]);
  const sibling = scriptedToolSequence([]);
  const host = await discoveryHost([discovering, loading, sibling], {
    policies: DEFAULT_PERMISSION_POLICIES,
    yolo: false,
  });

  const first = await host.run('List the worktrees');
  expect(first.at(-1)).toMatchObject({ outcome: 'completed', type: 'run.finished' });
  // Step 1: the eager tool and the discovery tools, but not the deferred one.
  expect(offered(discovering, 0)).toEqual(FIRST_STEP);
  // search_tools found it, load_tool loaded it, and the next step offers and runs it.
  const searched = first.find(
    (event) => event.type === 'effect.finished' && event.toolCallId === 'recorded-call-1'
  );
  expect(searched).toMatchObject({ output: { results: [{ name: DEFERRED }] } });
  expect(offered(discovering, 2)).toContain(DEFERRED);
  expect(first).toContainEqual(
    expect.objectContaining({
      output: { worktrees: [] },
      toolCallId: 'recorded-call-3',
      type: 'effect.finished',
    })
  );

  // A later run on the same branch sees the earlier load in its history, so the
  // tool must still be offered: a model told "Already loaded" that calls a tool
  // the request no longer declares loses the call (OpenRouter GLM via Together
  // billed ~8k tokens of canvas HTML and returned nothing, 2026-10-16).
  const second = await host.run('List them again');
  expect(second.at(-1)).toMatchObject({ outcome: 'completed', type: 'run.finished' });
  expect(offered(loading, 0)).toEqual([...FIRST_STEP, DEFERRED].sort());
  expect(offered(loading, 1)).toContain(DEFERRED);

  // A sibling branch from the thread root never saw that load: it starts unloaded.
  const third = await host.run('Start over', null);
  expect(third.at(-1)).toMatchObject({ outcome: 'completed', type: 'run.finished' });
  expect(offered(sibling, 0)).toEqual(FIRST_STEP);
  expect(second).toContainEqual(
    expect.objectContaining({
      output: { worktrees: [] },
      toolCallId: 'recorded-call-2',
      type: 'effect.finished',
    })
  );
});

test('the discovery tools never ask for permission, as legacy, even when reads ask', async () => {
  const discovering = scriptedToolSequence([
    { input: {}, toolId: 'list_available_tools' },
    { input: { query: 'git worktree' }, toolId: 'search_tools' },
    { input: { toolName: DEFERRED }, toolId: 'load_tool' },
  ]);
  const host = await discoveryHost([discovering], {
    policies: { ...DEFAULT_PERMISSION_POLICIES, read: 'ask' },
    yolo: false,
  });

  const events = await host.run('What can you load?');
  expect(events.filter((event) => event.type === 'interaction.requested')).toEqual([]);
  expect(events.at(-1)).toMatchObject({ outcome: 'completed', type: 'run.finished' });
  expect(
    events.filter((event) => event.type === 'effect.finished').map((event) => event.toolCallId)
  ).toEqual(['recorded-call-1', 'recorded-call-2', 'recorded-call-3']);
});

test('a deferred tool called before load_tool settles its run visibly, and never runs', async () => {
  const unloaded = scriptedToolSequence([{ input: {}, toolId: DEFERRED }]);
  const host = await discoveryHost([unloaded], {
    policies: DEFAULT_PERMISSION_POLICIES,
    yolo: false,
  });

  const events = await host.run('List the worktrees');
  // The unloaded call fails as an unavailable tool, committed where the user sees it.
  expect(events).toContainEqual(
    expect.objectContaining({
      chunk: expect.objectContaining({
        error: expect.stringContaining(`unavailable tool '${DEFERRED}'`),
        toolCallId: 'recorded-call-1',
        type: 'tool-error',
      }),
      type: 'stream.chunk',
    })
  );
  expect(events.filter((event) => event.type.startsWith('effect.'))).toEqual([]);
  // The model reads the failure and the run ends; it never waits on the call.
  expect(events.at(-1)).toMatchObject({ outcome: 'completed', type: 'run.finished' });
});

// Regression: the real host passed an empty eager surface to load_tool.
test('loading an already admitted eager tool succeeds through the production host', async () => {
  const model = scriptedToolSequence([
    { input: { toolNames: [EAGER, DEFERRED] }, toolId: 'load_tool' },
    { input: {}, toolId: EAGER },
    { input: {}, toolId: DEFERRED },
  ]);
  const host = await discoveryHost([model], { policies: DEFAULT_PERMISSION_POLICIES, yolo: false });
  const events = await host.run('Load and use the admitted tools.');
  expect(events.at(-1)).toMatchObject({ outcome: 'completed', type: 'run.finished' });
  expect(
    events.find(
      (event) => event.type === 'effect.finished' && event.toolCallId === 'recorded-call-1'
    )
  ).toMatchObject({ output: { alreadyLoaded: [EAGER], loaded: [DEFERRED], success: true } });
  expect(offered(model, 0)).toEqual(FIRST_STEP);
  expect(offered(model, 1)).toEqual([...FIRST_STEP, DEFERRED].sort());
});
