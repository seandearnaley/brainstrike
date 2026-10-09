import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLock, StateStore } from '@brainstrike/state-store';
import type { MockLanguageModelV4 } from 'ai/test';
import { expect, test } from 'vitest';
import { HostCore } from '../src/core.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../src/production-platform.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedToolSequence } from '../src/test-fixtures/scripted-model.js';

type Finished = Extract<HostEvent, { type: 'run.finished' }>;
type NativeOptions = NonNullable<ProductionHostRunConfiguration['memory']['native']['options']>;

const modelId = 'gpt-6-sol';
const configuration: RuntimeData = { model: modelId, provider: 'openai' };
const remembered = '# Fixture facts\n- favourite colour: teal';

async function memoryToolHost(options: NativeOptions, models: MockLanguageModelV4[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-memory-tools-')));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: join(
      import.meta.dirname,
      '../dist/adapters/memory-storage-calculator.js'
    ),
  });
  const platform = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async (): Promise<ProductionHostRunConfiguration> => ({
      configuration,
      durableConfiguration: { model: modelId, provider: 'openai' },
      maxSteps: 3,
      memory: {
        native: { options },
        observerModelId: 'openai::gpt-4.1-mini',
        recordPrompt: async () => undefined,
        resourceId: 'memory-tools-fixture',
      },
      providerRequestContext: {
        inputTokenLimit: 50_000,
        provider: 'openai',
        runtimeData: configuration,
      },
      resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
      tools: {},
      toolTimeoutMs: 10_000,
    }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => {
      const model = models.shift();
      if (!model) {
        throw new Error('The fixture has no scripted model for this run');
      }
      return model;
    },
    resolveProviderAuth: async () => undefined,
    startup: { register: async () => undefined, signal: new AbortController().signal, store },
  });
  const core = await HostCore.open(store, platform, () => () => undefined);
  const run = async (prompt: string, threadId?: string) => {
    const thread = threadId ?? (await core.startThread({ commandId: randomUUID() })).threadId;
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: `openai::${modelId}`,
      prompt,
      threadId: thread,
    });
    let events: HostEvent[] = [];
    await expect
      .poll(
        async () => {
          events = (await core.read(thread, 0)).map((row) => row.event);
          return events.some((event) => event.type === 'run.finished' && event.runId === runId);
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    const ofRun = events.filter((event) => 'runId' in event && event.runId === runId);
    return {
      events: ofRun,
      finished: ofRun.find((event): event is Finished => event.type === 'run.finished'),
      threadId: thread,
    };
  };
  return {
    close: async () => {
      await core.close();
      await platform.close();
      await store.close();
      expect(RootLock.inspect(root)?.owner.released).toBe(true);
      await rm(root, { force: true, recursive: true });
    },
    run,
  };
}

function systemText(model: MockLanguageModelV4): string {
  return (
    model.doStreamCalls[0]?.prompt
      .flatMap((message) => (message.role === 'system' ? [message.content] : []))
      .join('\n') ?? ''
  );
}

function toolNames(model: MockLanguageModelV4): string[] {
  return (model.doStreamCalls[0]?.tools ?? []).map((tool) => tool.name);
}

test('the model updates resource working memory through the canonical Memory tool', async () => {
  const writer = scriptedToolSequence([
    { input: { memory: remembered }, toolId: 'updateWorkingMemory' },
  ]);
  const reader = scriptedToolSequence([]);
  const host = await memoryToolHost(
    {
      lastMessages: 4,
      observationalMemory: false,
      semanticRecall: false,
      workingMemory: { enabled: true, scope: 'resource', template: '# Fixture facts' },
    },
    [writer, reader]
  );
  try {
    const first = await host.run('My favourite colour is teal; remember it.');
    expect(first.finished?.outcome).toBe('completed');
    expect(toolNames(writer)).toContain('updateWorkingMemory');
    // Mastra's own WM instruction names the tool the host now declares.
    expect(systemText(writer)).toContain('updateWorkingMemory');
    const effect = first.events.find((event) => event.type === 'effect.finished');
    expect(effect).toMatchObject({ output: { success: true } });

    // Resource scope: a new thread on the same resource receives the update.
    await host.run('What is my favourite colour?');
    expect(systemText(reader)).toContain('favourite colour: teal');
  } finally {
    await host.close();
  }
});

test('observational retrieval exposes the canonical recall tool over committed history', async () => {
  const observer = scriptedToolSequence([]);
  const model = scriptedToolSequence([{ input: { mode: 'threads' }, toolId: 'recall' }]);
  const host = await memoryToolHost(
    {
      lastMessages: 4,
      observationalMemory: {
        model: observer,
        observation: { messageTokens: 30_000 },
        reflection: { observationTokens: 40_000 },
        retrieval: { scope: 'thread' },
        scope: 'thread',
      },
      semanticRecall: false,
      workingMemory: { enabled: false },
    },
    [model]
  );
  try {
    const result = await host.run('Which thread is this?');
    expect(result.finished?.outcome).toBe('completed');
    expect(toolNames(model)).toContain('recall');
    const effect = result.events.find((event) => event.type === 'effect.finished');
    expect(JSON.stringify(effect)).toContain(result.threadId);
  } finally {
    await host.close();
  }
});

test('working memory that is off declares no Memory tool', async () => {
  const model = scriptedToolSequence([]);
  const host = await memoryToolHost(
    {
      lastMessages: 4,
      observationalMemory: false,
      semanticRecall: false,
      workingMemory: { enabled: false },
    },
    [model]
  );
  try {
    expect((await host.run('Hello')).finished?.outcome).toBe('completed');
    expect(toolNames(model)).not.toContain('updateWorkingMemory');
  } finally {
    await host.close();
  }
});
