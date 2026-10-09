/**
 * Gap 17: the desktop's legacy workspace working memory reaches the host's
 * first run, imported once before its Memory opens. Legacy resource
 * observations are not imported; the root is told once.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import type { MockLanguageModelV4 } from 'ai/test';
import { expect, test } from 'vitest';
import { HostCore } from '../src/core.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../src/production-platform.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedToolSequence } from '../src/test-fixtures/scripted-model.js';

const modelId = 'gpt-6-sol';
const configuration: RuntimeData = { model: modelId, provider: 'openai' };
const resourceId = 'legacy-memory-fixture';
const LEGACY_FACT = '- prefers tabs over spaces';
const HOST_FACT = '- the host already knew this';
const calculator = join(import.meta.dirname, '../dist/adapters/memory-storage-calculator.js');

/** Main's reply to `platform/memory/legacy`, as JSON over the platform connection. */
function legacyReply(resourceObservations: boolean): unknown {
  return {
    resource: {
      createdAt: '2026-09-01T08:00:00.000Z',
      id: resourceId,
      metadata: null,
      updatedAt: '2026-09-30T08:00:00.000Z',
      workingMemory: `# Notes\n${LEGACY_FACT}`,
    },
    resourceObservations,
  };
}

/** One host launch over `root`, with the desktop's legacy memory reader. */
async function launch(root: string, readLegacyMemory: () => Promise<unknown>) {
  const store = await StateStore.open(root, { memoryCalculatorModule: calculator });
  const models: MockLanguageModelV4[] = [];
  const platform = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async (): Promise<ProductionHostRunConfiguration> => ({
      configuration,
      durableConfiguration: { model: modelId, provider: 'openai' },
      maxSteps: 2,
      memory: {
        native: {
          options: {
            lastMessages: 4,
            observationalMemory: false,
            semanticRecall: false,
            workingMemory: { enabled: true, scope: 'resource', template: '# Notes' },
          },
        },
        recordPrompt: async () => undefined,
        resourceId,
      },
      providerRequestContext: { inputTokenLimit: 50_000, provider: 'openai' },
      resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
      tools: {},
      toolTimeoutMs: 10_000,
    }),
    readLegacyMemory,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => {
      const model = scriptedToolSequence([]);
      models.push(model);
      return model;
    },
    resolveProviderAuth: async () => undefined,
    startup: { register: async () => undefined, signal: new AbortController().signal, store },
  });
  const core = await HostCore.open(store, platform, () => () => undefined);
  /** A new thread's run: its committed events and the system text its model received. */
  const run = async () => {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: `openai::${modelId}`,
      prompt: 'What do you know about me?',
      threadId,
    });
    let events: HostEvent[] = [];
    await expect
      .poll(
        async () => {
          events = (await core.read(threadId, 0)).map((row) => row.event);
          return events.some((event) => event.type === 'run.finished' && event.runId === runId);
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    const system = (models.at(-1)?.doStreamCalls[0]?.prompt ?? [])
      .flatMap((message) => (message.role === 'system' ? [message.content] : []))
      .join('\n');
    return {
      notices: events.filter((event) => event.type === 'memory.observation.withheld'),
      system,
    };
  };
  return {
    close: async () => {
      await core.close();
      await platform.close();
      await store.close();
    },
    core,
    run,
    store,
  };
}

async function freshRoot(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), 'bs-legacy-memory-import-')));
}

test('the first run receives the legacy working memory; Main is read once and the root told once', async () => {
  const root = await freshRoot();
  let reads = 0;
  const read = async () => {
    reads += 1;
    return legacyReply(true);
  };
  let host = await launch(root, read);
  try {
    const first = await host.run();
    expect(first.system).toContain(LEGACY_FACT);
    expect(first.notices).toEqual([
      expect.objectContaining({ reason: 'legacy-resource-observations' }),
    ]);
    const second = await host.run();
    expect(second.system).toContain(LEGACY_FACT);
    expect(second.notices).toEqual([]);
    expect(reads).toBe(1);

    // A restart finds the completion marker and the committed notice.
    await host.close();
    host = await launch(root, read);
    const third = await host.run();
    expect(third.system).toContain(LEGACY_FACT);
    expect(third.notices).toEqual([]);
    expect(reads).toBe(1);
  } finally {
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('an existing host working memory is kept, and no observations means no notice', async () => {
  const root = await freshRoot();
  const store = await StateStore.open(root, { memoryCalculatorModule: calculator });
  try {
    await store.memory({
      changes: [
        {
          entity: {
            id: resourceId,
            kind: 'resource',
            payload: {
              createdAt: '2026-10-01T08:00:00.000Z',
              id: resourceId,
              updatedAt: '2026-10-01T08:00:00.000Z',
              workingMemory: `# Notes\n${HOST_FACT}`,
            },
            threadId: null,
          },
          operation: 'put',
        },
      ],
      expectedRevision: 0,
      operation: 'commit',
      resourceId,
    });
  } finally {
    await store.close();
  }
  const host = await launch(root, async () => legacyReply(false));
  try {
    const first = await host.run();
    expect(first.system).toContain(HOST_FACT);
    expect(first.system).not.toContain(LEGACY_FACT);
    expect(first.notices).toEqual([]);
    expect(
      (await host.store.memory({ operation: 'legacy-import-status', resourceId })).value
    ).toMatchObject({ resourceObservations: false, workingMemory: 'kept-host' });
  } finally {
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('a failed legacy read refuses the run, and the next run imports', async () => {
  const root = await freshRoot();
  let reads = 0;
  const host = await launch(root, async () => {
    reads += 1;
    if (reads === 1) {
      throw new Error('Main could not read the legacy memory');
    }
    return legacyReply(false);
  });
  try {
    const { threadId } = await host.core.startThread({ commandId: randomUUID() });
    await expect(
      host.core.startRun({
        commandId: randomUUID(),
        modelId: `openai::${modelId}`,
        prompt: 'Hello.',
        threadId,
      })
    ).rejects.toThrow('Main could not read the legacy memory');
    expect(
      (await host.store.memory({ operation: 'legacy-import-status', resourceId })).value
    ).toBeNull();
    const next = await host.run();
    expect(next.system).toContain(LEGACY_FACT);
    expect(reads).toBe(2);
  } finally {
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});
