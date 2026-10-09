// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { LocalLlmHostClient } from '@brainstrike/agent/provider-runtime';
import { type AgentHost, attachAgentHost, startAgentHost } from '@brainstrike/agent-host';
import type { CatalogEmbeddingWorkerPlan } from '@brainstrike/embeddings/inference-plan';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import { createHostPlatform } from '../agent-host-platform/desktop-node-platform';
import type { DesktopAdmissionReads } from '../agent-host-platform/desktop-run-admission';
import {
  type DesktopPlatformCapabilities,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
import { installParentPlatformPort } from '../agent-host-platform/parent-platform-port';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { MainMcpHostControl } from '../mcp/main-host-control';
import { type CapturedIntent, capturedIntent, mainReads } from './fixtures/desktop-admission-reads';
import { desktopAppPaths } from './fixtures/desktop-host-profile';

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

const MODEL = { model: 'gpt-6-sol', provider: 'openai' } as const;
type MemoryIntent = NonNullable<Parameters<typeof capturedIntent>[0]['memorySettings']>;

/** The composer's captured intent: the chat model, its memory settings, one step. */
function intent(memorySettings: MemoryIntent = {}): CapturedIntent {
  return capturedIntent({ ...MODEL, agentLoop: { maxSteps: 1 }, memorySettings });
}

/** Main's reads, recording the catalog read every admission and readiness starts with. */
function recordingReads(
  overrides: Partial<DesktopAdmissionReads> = {}
): DesktopAdmissionReads & { readonly admissions: number; readonly preconditions: number } {
  const counts = { admissions: 0, preconditions: 0 };
  const reads = mainReads(overrides);
  return {
    ...reads,
    get admissions() {
      return counts.admissions;
    },
    catalogModel: (...args: Parameters<DesktopAdmissionReads['catalogModel']>) => {
      counts.preconditions += 1;
      return reads.catalogModel(...args);
    },
    get preconditions() {
      return counts.preconditions;
    },
    // Only a run's admission reads the worktree service.
    worktreesAvailable: (signal: AbortSignal) => {
      counts.admissions += 1;
      return reads.worktreesAvailable(signal);
    },
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
  admission: DesktopAdmissionReads,
  local: Pick<DesktopPlatformCapabilities, 'localEmbedding' | 'localLlm'>,
  captured: CapturedIntent
) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-local-inference-'));
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const mainOwner = serveDesktopPlatform(mainPlatformConnection(mainPort), {
    ...local,
    admission,
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
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
    // A disposable, empty credential file: no keychain or real credential is read.
    const credentialStore = { kind: 'file' as const, path: join(root, 'credentials.json') };
    host = await startAgentHost(options, (context) =>
      createHostPlatform(options, context, { appPaths: desktopAppPaths(root), credentialStore })
    );
    client = await attachAgentHost(host.record);
  } catch (cause) {
    await close();
    throw cause;
  }
  const attached = client;
  return {
    close,
    /** Memory readiness for the thread's next run, as the composer reads it before Send. */
    memory(threadId: string, configuration: CapturedIntent = captured) {
      return attached.request('thread/memory/read', {
        configuration,
        modelId: 'openai::gpt-6-sol',
        threadId,
      });
    },
    async run(prompt: string) {
      const { threadId } = await attached.request('thread/start', { commandId: randomUUID() });
      await attached.request('run/start', {
        commandId: randomUUID(),
        configuration: captured,
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
    async thread() {
      return (await attached.request('thread/start', { commandId: randomUUID() })).threadId;
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
  const reads = recordingReads();
  const host = await borrowedHost(
    reads,
    { localLlm: { generate, warmup } },
    intent({
      observationalMemory: {
        enabled: true,
        // The committed prompt alone crosses this threshold (buffering needs >= 1 token).
        messageTokens: 5,
        modelTarget: `local/${observerModel}`,
      },
    })
  );
  try {
    // Before any run: only the preconditions run, so no selection and no observer warmup.
    const fresh = await host.thread();
    expect(await host.memory(fresh)).toEqual({
      admission: { ready: true },
      observational: { record: null, state: 'active' },
    });
    expect(reads.preconditions).toBe(1);
    expect(reads.admissions).toBe(0);
    expect(warmup).not.toHaveBeenCalled();
    const { events, threadId } = await host.run('My favourite colour is teal.');
    expect(reads.admissions).toBe(1);
    // Cold loads are warmed before the run, as legacy did.
    expect(warmup.mock.calls[0]?.[0]).toBe(observerModel);
    expect(generate.mock.calls[0]?.[0].modelId).toBe(observerModel);
    // The observer's usage is attributed to its catalog model, so it can be priced.
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'observation',
        modelId: `local::${observerModel}`,
        type: 'memory.usage',
      })
    );
    // The meter's memory segment reads the committed observation record before the next send.
    // The one observation above is 7 tokens, active and nothing pending.
    const warmups = warmup.mock.calls.length;
    expect(await host.memory(threadId)).toEqual({
      admission: { ready: true },
      observational: {
        record: {
          bufferedObservationTokens: 0,
          messageTokenThreshold: 5,
          observationTokenCount: 7,
          pendingMessageTokens: 0,
          totalTokensObserved: 7,
        },
        state: 'active',
      },
    });
    expect(warmup.mock.calls.length).toBe(warmups);
    expect(reads.admissions).toBe(1);
  } finally {
    await host.close();
  }
});

test('thread/memory/read shows a waiting observer, a missing credential and Main’s reason', async () => {
  // No real credential is read: the observer's provider has none in this profile.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  const reads = recordingReads({
    // Main resolves a recall embedder only for settings that use one; its host is down.
    memoryVectors: async (settings) => {
      if (settings.semanticRecall.enabled) {
        throw new Error('The embedding host is not running.');
      }
      return;
    },
  });
  const host = await borrowedHost(
    reads,
    { localLlm: { generate: vi.fn(), warmup: vi.fn() } },
    intent()
  );
  try {
    const threadId = await host.thread();
    // Auto observes with the chat provider's own candidates; the catalog enables none.
    expect(
      await host.memory(
        threadId,
        intent({ observationalMemory: { enabled: true, modelTarget: 'auto' } })
      )
    ).toEqual({
      admission: { ready: true },
      observational: { reason: 'model-not-eligible', state: 'awaiting-observer' },
    });
    // The credential resolution the run's observer makes, named as legacy names it.
    expect(
      await host.memory(
        threadId,
        intent({
          observationalMemory: { enabled: true, modelTarget: 'anthropic/claude-haiku-4-5' },
        })
      )
    ).toEqual({
      admission: {
        ready: false,
        reason:
          'Observational memory requires a configured Anthropic API key. Configure it in Settings → Providers, choose a keyless local observer, or turn observations off.',
      },
    });
    // Main's own reason: the recall embedder it would resolve is unavailable.
    expect(
      await host.memory(
        threadId,
        intent({
          semanticRecall: {
            embeddingModelTarget: `local/${embeddingPlan.modelId}`,
            enabled: true,
          },
        })
      )
    ).toEqual({
      admission: { ready: false, reason: 'The embedding host is not running.' },
    });
    expect(reads.admissions).toBe(0);
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
  const recall = {
    semanticRecall: { embeddingModelTarget: `local/${embeddingPlan.modelId}`, enabled: true },
  };
  const host = await borrowedHost(
    recordingReads({
      memoryVectors: async () => ({
        local: { modelKey: `local::${embeddingPlan.modelId}`, workerPlan: embeddingPlan },
        profile: {
          dimensions: embeddingPlan.dimensions,
          distance: 'cosine',
          dtype: embeddingPlan.dtype,
          modelId: embeddingPlan.modelId,
          provider: 'local',
        },
      }),
    }),
    { localEmbedding: { queryEmbedding } },
    intent(recall)
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
