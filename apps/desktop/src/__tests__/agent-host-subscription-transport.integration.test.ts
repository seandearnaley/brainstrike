// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { HostCore, type HostPlatform } from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import { createHostPlatform } from '../agent-host-platform/desktop-node-platform';
import {
  type DesktopPlatformSelection,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
import { installParentPlatformPort } from '../agent-host-platform/parent-platform-port';
import { createCodexFetch } from '../provider-auth/codex-fetch';
import { CODEX_RESPONSES_ENDPOINT } from '../provider-auth/descriptors/openai-codex';

const candidate = join(import.meta.dirname, '../../../..');

/** Same public MessageEvent shape as the Electron utility port, backed by real Node ports. */
class UtilityPort extends EventEmitter implements PlatformMessagePort {
  readonly sent: unknown[] = [];
  constructor(private readonly port: MessagePort) {
    super();
    port.on('message', (data: unknown) => this.emit('message', { data }));
    port.on('close', () => this.emit('close'));
  }
  start(): void {
    this.port.start();
  }
  postMessage(message: unknown): void {
    this.sent.push(message);
    this.port.postMessage(message);
  }
  close(): void {
    this.port.close();
  }
}

afterEach(() => vi.unstubAllGlobals());

test('production Node host retains the existing subscription fetch over its private platform port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-subscription-port-'));
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const server = mainPlatformConnection(mainPort);
  const cleanup: (() => void | Promise<void>)[] = [];
  const release = vi.fn(async () => undefined);
  const token = 'synthetic-offline-subscription-bearer';
  const requests: Request[] = [];
  const baseFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json(
      {
        error: {
          message: 'Offline fixture stops after request serialization',
          type: 'fixture_terminal',
        },
      },
      { status: 400 }
    );
  });
  // Every fetch is intercepted, including accidental dummy-key fallback.
  vi.stubGlobal('fetch', baseFetch);
  const freshToken = vi.fn(async () => token);
  // Existing authenticated closure only: no engine, login, secret writer or
  // new auth grant is constructed. The selection has already resolved it.
  const selectedFetch = createCodexFetch({
    baseFetch,
    getAccessToken: freshToken,
    getAccountId: () => 'synthetic-account',
    sessionId: 'synthetic-session',
    userAgent: 'brainstrike/fixture',
  });
  const selection: DesktopPlatformSelection = {
    close: release,
    configuration: { model: 'codex/gpt-6-sol', provider: 'openai-codex' },
    contextWindow: 32_000,
    durableConfiguration: { model: 'codex/gpt-6-sol', provider: 'openai-codex' },
    inputTokenLimit: 24_000,
    maxSteps: 1,
    memory: {
      options: {
        lastMessages: 12,
        workingMemory: { enabled: false, scope: 'thread', template: '' },
      },
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
    resourceId: 'subscription-private-port-fixture',
    tools: {},
    toolTimeoutMs: 5000,
  };
  const auth = vi.fn(async (provider: string) => {
    expect(provider).toBe('openai-codex');
    return { apiKey: 'sdk-dummy-fixture-key', fetch: selectedFetch, kind: 'custom_fetch' as const };
  });
  const mainOwner = serveDesktopPlatform(server, {
    readConfiguration: async () => selection,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveProviderAuth: auth,
  });
  const store = await StateStore.open(root, {
    memoryCalculatorModule: join(
      candidate,
      'packages/agent-host/dist/adapters/memory-storage-calculator.js'
    ),
  });
  let core: HostCore | undefined;
  let platform: HostPlatform | undefined;
  try {
    expect(
      installParentPlatformPort({ data: { event: 'platform-capabilities' }, ports: [nodePort] })
    ).toBe(true);
    platform = await createHostPlatform(
      { lifetime: 'app', root },
      {
        register: async (task) => {
          cleanup.push(task);
        },
        signal: new AbortController().signal,
        store,
      }
    );
    core = await HostCore.open(store, platform, () => () => undefined);
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    // Success here means actual admission, not socket closure or PID liveness.
    await expect(
      core.startRun({
        commandId: randomUUID(),
        modelId: 'openai-codex::codex/gpt-6-sol',
        prompt: 'Read README.md',
        threadId,
      })
    ).resolves.toMatchObject({ runId: expect.any(String) });
    await expect.poll(() => requests.length).toBe(1);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(freshToken).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...mainPort.sent, ...nodePort.sent])).not.toContain(token);
    const request = requests[0];
    if (!request) {
      throw new Error('Subscription transport did not forward the SDK request');
    }
    expect(request.url).toBe(CODEX_RESPONSES_ENDPOINT);
    expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(request.headers.get('chatgpt-account-id')).toBe('synthetic-account');
    expect(z.object({ store: z.literal(false) }).parse(await request.json()).store).toBe(false);
  } finally {
    if (core) {
      await core.close();
    } else {
      await platform?.close();
    }
    await mainOwner.close();
    for (const task of cleanup.reverse()) {
      await task();
    }
    server.dispose();
    mainPort.close();
    nodePort.close();
    await store.close();
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await rm(root, { force: true, recursive: true });
    expect(release).toHaveBeenCalledTimes(1);
  }
});
