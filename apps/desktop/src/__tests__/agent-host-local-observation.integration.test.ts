// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { LocalLlmHostClient } from '@brainstrike/agent/provider-runtime';
import { type AgentHost, attachAgentHost, startAgentHost } from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import type { CatalogEmbeddingWorkerPlan } from '@brainstrike/embeddings/inference-plan';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import { createHostPlatform } from '../agent-host-platform/desktop-node-platform';
import {
  type DesktopPlatformCapabilities,
  type DesktopPlatformSelection,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
import { installParentPlatformPort } from '../agent-host-platform/parent-platform-port';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { RemoteMcpRuntime } from '../mcp/remote-runtime';

/** Same public MessageEvent shape as the Electron utility port, backed by real Node ports. */
class UtilityPort extends EventEmitter implements PlatformMessagePort {
  constructor(private readonly port: MessagePort) {
    super();
    port.on('message', (data: unknown) => this.emit('message', { data }));
    port.on('close', () => this.emit('close'));
  }
  start(): void {
    this.port.start();
  }
  postMessage(message: unknown): void {
    this.port.postMessage(message);
  }
  close(): void {
    this.port.close();
  }
}

const observerModel = 'gemma-4-e2b-it';
const embeddingPlan: CatalogEmbeddingWorkerPlan = {
  device: 'wasm',
  dimensions: 8,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
};

type Memory = DesktopPlatformSelection['memory'];
const settings: Memory['settings'] = {
  observationalMemory: {
    enabled: false,
    messageTokens: 30_000,
    modelTarget: 'openai/gpt-4.1-mini',
    observationTokens: 40_000,
    retrievalMode: 'off',
    scope: 'thread',
  },
  semanticRecall: {
    embeddingModelTarget: null,
    enabled: false,
    messageRange: 0,
    scope: 'resource',
    topK: 1,
  },
};

function selection(
  threadId: string,
  memory: Partial<Memory>,
  local?: Pick<DesktopPlatformSelection, 'localEmbedding'>
): DesktopPlatformSelection {
  return {
    close: async () => undefined,
    configuration: { model: 'gpt-6-sol', provider: 'openai' },
    contextWindow: 128_000,
    durableConfiguration: { model: 'gpt-6-sol', provider: 'openai', threadId },
    freshWorkspaceRoots: async () => [],
    inputTokenLimit: 64_000,
    maxSteps: 1,
    memory: {
      options: {
        lastMessages: 4,
        workingMemory: { enabled: false, scope: 'thread', template: '' },
      },
      settings,
      ...memory,
    },
    nativeRuntime: { provider: 'openai', workspaceRoots: [] },
    // The desktop host acquires vectors for the workspace memory resource only.
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    tools: {},
    toolTimeoutMs: 5000,
    ...local,
  };
}

beforeEach(() => {
  // Every provider request is intercepted: nothing leaves the process.
  vi.stubEnv('OPENAI_API_KEY', 'offline-fixture-key');
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { type: 'fixture_terminal' } }, { status: 400 })
    )
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Real Main platform and Node host over a private channel; only inference is faked. */
async function borrowedHost(
  admit: (threadId: string) => DesktopPlatformSelection,
  local: Pick<DesktopPlatformCapabilities, 'localEmbedding' | 'localLlm'>
) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-local-inference-'));
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const mainOwner = serveDesktopPlatform(mainPlatformConnection(mainPort), {
    ...local,
    mcp: createDesktopMcpPlatformCapabilities(new RemoteMcpRuntime()),
    readConfiguration: async (request) => admit(request.threadId),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveProviderAuth: async () => undefined,
  });
  let host: AgentHost | undefined;
  let client: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
  const close = async (): Promise<void> => {
    await client?.close();
    await host?.close();
    await mainOwner.close();
    mainPort.close();
    nodePort.close();
    await rm(root, { force: true, recursive: true });
  };
  try {
    expect(
      installParentPlatformPort({ data: { event: 'platform-capabilities' }, ports: [nodePort] })
    ).toBe(true);
    const options = { lifetime: 'persistent' as const, root };
    host = await startAgentHost(options, (context) => createHostPlatform(options, context));
    client = await attachAgentHost(host.record);
  } catch (cause) {
    await close();
    throw cause;
  }
  const attached = client;
  return {
    close,
    async run(prompt: string) {
      const { threadId } = await attached.request('thread/start', { commandId: randomUUID() });
      await attached.request('run/start', {
        commandId: randomUUID(),
        modelId: 'openai::gpt-6-sol',
        prompt,
        threadId,
      });
      let events: { type: string; kind?: string; modelId?: string }[] = [];
      await expect
        .poll(
          async () => {
            events = (await attached.request('thread/read', { fromSeq: 0, threadId })).rows.map(
              ({ event }) => event
            );
            return events.some((event) => event.type === 'run.finished');
          },
          { timeout: 30_000 }
        )
        .toBe(true);
      return { events, threadId };
    },
  };
}

/**
 * ADR-0007: the Node host never runs local inference. A local observer reaches
 * Main's borrowed llm-host over the private platform channel, like legacy did.
 */
test('a local observational-memory observer runs through Main’s borrowed local LLM host', async () => {
  const generate = vi.fn<LocalLlmHostClient['generate']>(async () => ({
    finishReason: 'stop',
    text: '<observations>\n- The user prefers teal.\n</observations>',
    usage: { completionTokens: 9, promptTokens: 40, totalTokens: 49 },
  }));
  const warmup = vi.fn<LocalLlmHostClient['warmup']>(async () => undefined);
  const admitted: string[] = [];
  const host = await borrowedHost(
    (threadId) => {
      admitted.push(threadId);
      return selection(threadId, {
        settings: {
          ...settings,
          observationalMemory: {
            ...settings.observationalMemory,
            enabled: true,
            // The committed prompt alone crosses this threshold (buffering needs >= 1 token).
            messageTokens: 5,
            modelTarget: `local/${observerModel}`,
          },
        },
      });
    },
    { localLlm: { generate, warmup } }
  );
  try {
    const { events, threadId } = await host.run('My favourite colour is teal.');
    expect(admitted).toEqual([threadId]);
    // Cold loads are warmed before the run, as legacy did.
    expect(warmup.mock.calls[0]?.[0]).toBe(observerModel);
    expect(generate.mock.calls[0]?.[0].modelId).toBe(observerModel);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'observation', modelId: observerModel, type: 'memory.usage' })
    );
  } finally {
    await host.close();
  }
});

test('local recall queries Main’s borrowed embedding host with the admitted saved plan', async () => {
  const queryEmbedding = vi.fn<
    NonNullable<DesktopPlatformCapabilities['localEmbedding']>['queryEmbedding']
  >(async (_payload, options) => {
    options?.signal?.throwIfAborted();
    return Array.from({ length: embeddingPlan.dimensions }, (_, index) => (index ? 0 : 1));
  });
  const host = await borrowedHost(
    (threadId) =>
      selection(
        threadId,
        {
          settings: {
            ...settings,
            semanticRecall: {
              ...settings.semanticRecall,
              embeddingModelTarget: `local/${embeddingPlan.modelId}`,
              enabled: true,
            },
          },
          vectorProfile: {
            dimensions: embeddingPlan.dimensions,
            distance: 'cosine',
            dtype: embeddingPlan.dtype,
            modelId: embeddingPlan.modelId,
            provider: 'local',
          },
        },
        {
          localEmbedding: {
            modelKey: `local::${embeddingPlan.modelId}`,
            workerPlan: embeddingPlan,
          },
        }
      ),
    { localEmbedding: { queryEmbedding } }
  );
  try {
    await host.run('Which city did I mention?');
    expect(queryEmbedding).toHaveBeenCalledWith(
      {
        dimensions: embeddingPlan.dimensions,
        inferencePlan: embeddingPlan,
        modelId: embeddingPlan.modelId,
        modelKey: `local::${embeddingPlan.modelId}`,
        query: 'Which city did I mention?',
      },
      { signal: expect.any(AbortSignal) }
    );
  } finally {
    await host.close();
  }
});
