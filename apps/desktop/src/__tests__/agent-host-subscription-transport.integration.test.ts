// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { createProvider } from '@brainstrike/agent/provider-runtime';
import { HostCore, type HostPlatform, materializeHostProviderModel } from '@brainstrike/agent-host';
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
import {
  createProviderFetchTransport,
  serveProviderFetchTransport,
} from '../agent-host-platform/provider-fetch-transport';
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
    freshWorkspaceRoots: async () => [],
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
    nativeRuntime: { provider: 'openai-codex', workspaceRoots: [] },
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

const admittedScope = { provider: 'openai-codex', threadId: 'existing-admitted-thread' };

async function withFetchPort(
  capturedFetch: typeof globalThis.fetch,
  work: (port: {
    client: ReturnType<typeof createProviderFetchTransport>;
    main: ReturnType<typeof serveProviderFetchTransport>;
    mainConnection: ReturnType<typeof mainPlatformConnection>;
    nodeConnection: ReturnType<typeof mainPlatformConnection>;
    sent(): unknown[];
  }) => Promise<void>
): Promise<void> {
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const mainConnection = mainPlatformConnection(mainPort);
  const nodeConnection = mainPlatformConnection(nodePort);
  const main = serveProviderFetchTransport(mainConnection, {
    getFetch: (scope) => {
      if (scope.threadId !== admittedScope.threadId || scope.provider !== admittedScope.provider) {
        throw new Error('Scope has no captured subscription capability');
      }
      return capturedFetch;
    },
  });
  const client = createProviderFetchTransport(nodeConnection, admittedScope);
  mainConnection.listen();
  nodeConnection.listen();
  try {
    await work({
      client,
      main,
      mainConnection,
      nodeConnection,
      sent: () => [...mainPort.sent, ...nodePort.sent],
    });
  } finally {
    await client.close();
    await main.close();
    nodeConnection.dispose();
    mainConnection.dispose();
    nodePort.close();
    mainPort.close();
  }
}

test('allocated fetch helper retains Main auth and forwards actual HTTP metadata and error body', async () => {
  const requests: Request[] = [];
  const bearer = 'synthetic-private-main-bearer';
  const freshToken = vi.fn(async () => bearer);
  const selected = createCodexFetch({
    baseFetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(
        { error: { type: 'fixture_terminal' } },
        {
          headers: { 'x-request-id': 'offline-request' },
          status: 400,
          statusText: 'Fixture rejected',
        }
      );
    },
    getAccessToken: freshToken,
    getAccountId: () => 'synthetic-account',
    sessionId: 'synthetic-session',
    userAgent: 'brainstrike/fixture',
  });
  await withFetchPort(selected, async ({ client, sent }) => {
    const response = await client.fetch('https://api.openai.com/v1/responses', {
      body: JSON.stringify({ input: [], model: 'gpt-6-sol', store: true }),
      headers: {
        authorization: 'Bearer sdk-dummy-fixture-key',
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect(response.statusText).toBe('Fixture rejected');
    expect(response.headers.get('x-request-id')).toBe('offline-request');
    expect(await response.json()).toEqual({ error: { type: 'fixture_terminal' } });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) {
      throw new Error('Main subscription closure was not called');
    }
    expect(request.url).toBe(CODEX_RESPONSES_ENDPOINT);
    expect(request.headers.get('authorization')).toBe(`Bearer ${bearer}`);
    expect(request.headers.get('chatgpt-account-id')).toBe('synthetic-account');
    expect(await request.json()).toMatchObject({ store: false });
    expect(freshToken).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent())).not.toContain(bearer);
  });
});

test('allocated fetch helper carries an actual shipped subscription SDK request through the private port', async () => {
  const requests: Request[] = [];
  const bearer = 'synthetic-sdk-main-bearer';
  const freshToken = vi.fn(async () => bearer);
  const baseFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(
      { error: { message: 'Offline SDK transport qualification', type: 'fixture_terminal' } },
      { status: 400 }
    );
  });
  vi.stubGlobal('fetch', baseFetch);
  const selected = createCodexFetch({
    baseFetch,
    getAccessToken: freshToken,
    sessionId: 'synthetic-sdk-session',
    userAgent: 'brainstrike/fixture',
  });
  await withFetchPort(selected, async ({ client, sent }) => {
    const model = materializeHostProviderModel(
      createProvider(
        'openai-codex',
        {
          apiKey: 'sdk-dummy-fixture-key',
          fetch: client.fetch,
          kind: 'custom_fetch',
        },
        'codex/gpt-6-sol'
      )
    );
    await expect(
      model.doGenerate({
        prompt: [
          { content: [{ text: 'Recorded offline SDK request', type: 'text' }], role: 'user' },
        ],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(requests).toHaveLength(1);
    expect(freshToken).toHaveBeenCalledTimes(1);
    const request = requests[0];
    if (!request) {
      throw new Error('SDK did not reach the Main subscription closure');
    }
    expect(request.url).toBe(CODEX_RESPONSES_ENDPOINT);
    expect(request.headers.get('authorization')).toBe(`Bearer ${bearer}`);
    expect(await request.json()).toMatchObject({ store: false });
    expect(JSON.stringify(sent())).not.toContain(bearer);
  });
});

test('allocated fetch helper streams response bytes on demand and physically joins reader cancellation', async () => {
  const cancel = vi.fn(async () => undefined);
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(new TextEncoder().encode('data: first\n\n'));
  });
  const selected: typeof globalThis.fetch = async () =>
    new Response(new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 }), {
      headers: { 'content-type': 'text/event-stream' },
    });
  await withFetchPort(selected, async ({ client }) => {
    const response = await client.fetch('https://offline.invalid/responses');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(pull).not.toHaveBeenCalled();
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Missing streaming response');
    }
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    expect(pull).toHaveBeenCalledTimes(1);
    await reader.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

test('allocated fetch helper abort and release wait for an ignoring fetch and its body tail', async () => {
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const cancelling = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const selected = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    entered.resolve();
    return await response.promise;
  });
  await withFetchPort(selected, async ({ client, main }) => {
    const abort = new AbortController();
    const result = client.fetch('https://offline.invalid/responses', { signal: abort.signal }).then(
      () => ({ success: true }),
      (cause: unknown) => ({ cause, success: false })
    );
    await entered.promise;
    abort.abort(new Error('Fixture run cancelled'));
    let released = false;
    const release = main.release(admittedScope.threadId).then(() => {
      released = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(released).toBe(false);
    response.resolve(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            cancel: async () => {
              cancelling.resolve();
              await cancelled.promise;
            },
          },
          { highWaterMark: 0 }
        )
      )
    );
    await cancelling.promise;
    let closed = false;
    const close = main.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(released).toBe(false);
    expect(closed).toBe(false);
    cancelled.resolve();
    await Promise.all([release, close]);
    expect((await result).success).toBe(false);
    expect(selected).toHaveBeenCalledTimes(1);
  });
});

test('allocated fetch helper rejects cross-thread and cross-provider requests without a new auth grant', async () => {
  const selected = vi.fn<typeof globalThis.fetch>(async () => new Response('offline body'));
  await withFetchPort(selected, async ({ client, nodeConnection }) => {
    const response = await client.fetch('https://offline.invalid/responses');
    await expect(
      nodeConnection.sendRequest('platform/provider-fetch/read', {
        ...admittedScope,
        progressToken: 1,
        threadId: 'another-thread',
      })
    ).rejects.toThrow('not admitted');
    await expect(
      nodeConnection.sendRequest('platform/provider-fetch/read', {
        ...admittedScope,
        progressToken: 1,
        provider: 'another-provider',
      })
    ).rejects.toThrow('not admitted');
    const denied = createProviderFetchTransport(nodeConnection, {
      ...admittedScope,
      threadId: 'another-thread',
    });
    await expect(denied.fetch('https://offline.invalid/responses')).rejects.toThrow(
      'no captured subscription'
    );
    await denied.close();
    await response.body?.cancel();
    expect(selected).toHaveBeenCalledTimes(1);
  });
});

test('allocated fetch helper connection disposal retains an observable physical body join', async () => {
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const mainConnection = mainPlatformConnection(mainPort);
  const nodeConnection = mainPlatformConnection(nodePort);
  const cancelling = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const main = serveProviderFetchTransport(mainConnection, {
    getFetch: () => async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            cancel: async () => {
              cancelling.resolve();
              await cancelled.promise;
            },
          },
          { highWaterMark: 0 }
        )
      ),
  });
  const client = createProviderFetchTransport(nodeConnection, admittedScope);
  mainConnection.listen();
  nodeConnection.listen();
  try {
    await client.fetch('https://offline.invalid/responses');
    mainConnection.dispose();
    nodeConnection.dispose();
    await cancelling.promise;
    let joined = false;
    const close = main.close().then(() => {
      joined = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(joined).toBe(false);
    cancelled.resolve();
    await close;
    expect(joined).toBe(true);
    // Requester transport loss is reported, not interpreted as provider success.
    await expect(client.close()).rejects.toThrow('cleanup failed');
  } finally {
    cancelled.resolve();
    await main.close();
    mainConnection.dispose();
    nodeConnection.dispose();
    mainPort.close();
    nodePort.close();
  }
});

test('allocated fetch helper retains a failed body cancellation through client close and Main release/close', async () => {
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const mainConnection = mainPlatformConnection(mainPort);
  const nodeConnection = mainPlatformConnection(nodePort);
  const cause = new Error('Recorded body cancellation could not join');
  const cancel = vi.fn(async () => {
    throw cause;
  });
  const main = serveProviderFetchTransport(mainConnection, {
    getFetch: () => async () =>
      new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })),
  });
  const client = createProviderFetchTransport(nodeConnection, admittedScope);
  mainConnection.listen();
  nodeConnection.listen();
  const containsCause = (value: unknown, original: unknown): boolean =>
    value === original ||
    (value instanceof AggregateError &&
      value.errors.some((nested: unknown) => containsCause(nested, original)));
  try {
    const response = await client.fetch('https://offline.invalid/responses');
    if (!response.body) {
      throw new Error('Missing body for actual cancellation failure');
    }
    const [bodyCancellation] = await Promise.allSettled([response.body.cancel()]);
    if (bodyCancellation?.status !== 'rejected') {
      throw new Error('The source body cancellation failure was hidden');
    }
    const [clientClose, mainRelease] = await Promise.allSettled([
      client.close(),
      main.release(admittedScope.threadId),
    ]);
    const [mainClose] = await Promise.allSettled([main.close()]);
    expect([clientClose?.status, mainRelease?.status, mainClose?.status]).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    if (
      clientClose?.status !== 'rejected' ||
      mainRelease?.status !== 'rejected' ||
      mainClose?.status !== 'rejected'
    ) {
      throw new Error('A failed provider body join was forgotten');
    }
    expect(containsCause(clientClose.reason, bodyCancellation.reason)).toBe(true);
    expect(containsCause(mainRelease.reason, cause)).toBe(true);
    expect(containsCause(mainClose.reason, cause)).toBe(true);
    // Re-observation reuses the failed joins, without a retry or another fetch.
    await expect(client.close()).rejects.toBe(clientClose.reason);
    await expect(main.release(admittedScope.threadId)).rejects.toBe(mainRelease.reason);
    await expect(main.close()).rejects.toBe(mainClose.reason);
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally {
    // The rejected joins were inspected above; dispose test transports while
    // preserving those failures instead of claiming successful owner cleanup.
    await Promise.allSettled([client.close(), main.close()]);
    mainConnection.dispose();
    nodeConnection.dispose();
    mainPort.close();
    nodePort.close();
  }
});
