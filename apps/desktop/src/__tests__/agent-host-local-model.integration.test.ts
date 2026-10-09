// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { LocalLlmHostGenerateRequest } from '@brainstrike/agent/local-llm';
import {
  type AgentHost,
  authenticateHostClient,
  type HostClient,
  startAgentHost,
} from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test, vi } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import { createHostPlatform } from '../agent-host-platform/desktop-node-platform';
import type { DesktopLlmHostInference } from '../agent-host-platform/llm-host-port';
import {
  type DesktopPlatformSelection,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
import { installParentPlatformPort } from '../agent-host-platform/parent-platform-port';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { RemoteMcpRuntime } from '../mcp/remote-runtime';

const LOCAL_MODEL = 'onnx-community/gemma-4-E2B-it-ONNX';
const REPLY = 'Answered by the hidden llm-host renderer.';

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

const selection: DesktopPlatformSelection = {
  close: async () => undefined,
  configuration: { model: LOCAL_MODEL, provider: 'local' },
  contextWindow: 8192,
  durableConfiguration: { model: LOCAL_MODEL, provider: 'local' },
  freshWorkspaceRoots: async () => [],
  inputTokenLimit: 6000,
  maxSteps: 1,
  memory: {
    options: { lastMessages: 12, workingMemory: { enabled: false, scope: 'thread', template: '' } },
    settings: {
      observationalMemory: {
        enabled: false,
        messageTokens: 30_000,
        modelTarget: 'auto',
        observationTokens: 40_000,
        retrievalMode: 'off',
        scope: 'thread',
      },
      semanticRecall: {
        embeddingModelTarget: null,
        enabled: false,
        messageRange: 2,
        scope: 'resource',
        topK: 5,
      },
    },
  },
  nativeRuntime: { provider: 'local', workspaceRoots: [] },
  resourceId: 'local-model-fixture',
  tools: {},
  toolTimeoutMs: 5000,
};

/** Main's hidden-host manager surface, scripted: what the llm-host renderer would answer. */
function scriptedInference() {
  const warmed: string[] = [];
  const generated: LocalLlmHostGenerateRequest[] = [];
  const inference: DesktopLlmHostInference = {
    generateForMain: vi.fn(async (payload, options) => {
      generated.push(payload);
      // Cumulative snapshots, as the renderer reports them while generating.
      options.onProgress?.({ kind: 'text', text: REPLY.slice(0, 10) });
      options.onProgress?.({ kind: 'text', text: REPLY });
      return {
        finishReason: 'stop',
        text: REPLY,
        usage: { completionTokens: 8, promptTokens: 21, totalTokens: 29 },
      };
    }),
    warmupForMain: vi.fn(async (modelId) => {
      warmed.push(modelId);
    }),
  };
  return { generated, inference, warmed };
}

/** Main's own client shape: a private port the host binds as the desktop origin. */
async function desktopClient(host: AgentHost): Promise<HostClient> {
  const channel = new MessageChannel();
  const mainSide = new UtilityPort(channel.port1);
  const hostSide = new UtilityPort(channel.port2);
  host.bindClientConnection(mainPlatformConnection(hostSide), 'desktop-ui');
  const closed = new Promise<void>((resolve) => mainSide.once('close', () => resolve()));
  return await authenticateHostClient(
    mainPlatformConnection(mainSide),
    host.record,
    async () => {
      mainSide.close();
      hostSide.close();
    },
    closed
  );
}

afterEach(() => vi.unstubAllGlobals());

/**
 * ADR-0007: a host thread's built-in local model generates in the desktop's
 * hidden llm-host renderer. The host relays the generation over its private
 * Main port; it never loads a model, and no provider egress happens.
 */
test('a host thread on the built-in local model generates through the hidden llm-host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-local-model-'));
  const egress = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error('A local-model run reached the network');
  });
  vi.stubGlobal('fetch', egress);
  const { generated, inference, warmed } = scriptedInference();
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const mainOwner = serveDesktopPlatform(mainPlatformConnection(mainPort), {
    llmHost: inference,
    mcp: createDesktopMcpPlatformCapabilities(new RemoteMcpRuntime()),
    readConfiguration: async () => selection,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
  });
  let host: AgentHost | undefined;
  let desktop: HostClient | undefined;
  try {
    expect(
      installParentPlatformPort({ data: { event: 'platform-capabilities' }, ports: [nodePort] })
    ).toBe(true);
    const options = { lifetime: 'persistent' as const, root };
    host = await startAgentHost(options, (context) =>
      createHostPlatform(options, context, {
        credentialStore: { kind: 'file', path: join(root, 'credentials.json') },
      })
    );
    desktop = await desktopClient(host);
    const ui = desktop;
    const { threadId } = await ui.request('thread/start', { commandId: randomUUID() });
    await ui.request('run/start', {
      commandId: randomUUID(),
      modelId: `local::${LOCAL_MODEL}`,
      prompt: 'Say hello locally.',
      threadId,
    });
    await expect
      .poll(
        async () =>
          (await ui.request('thread/read', { fromSeq: 0, threadId })).rows.find(
            ({ event }) => event.type === 'run.finished'
          )?.event
      )
      .toMatchObject({ outcome: 'completed' });

    expect(warmed).toEqual([LOCAL_MODEL]);
    expect(generated.length).toBeGreaterThan(0);
    expect(generated[0]).toMatchObject({ modelId: LOCAL_MODEL });
    const rows = (await ui.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(JSON.stringify(rows)).toContain(REPLY);
    expect(egress).not.toHaveBeenCalled();
  } finally {
    await desktop?.close();
    await host?.close();
    await mainOwner.close();
    mainPort.close();
    nodePort.close();
    await rm(root, { force: true, recursive: true });
  }
});
