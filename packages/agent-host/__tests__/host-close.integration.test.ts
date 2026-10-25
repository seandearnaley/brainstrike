// Ported from the socket host's retirement proofs (closing-refusal, host-closing-announcement and
// socket-retirement, deleted with host-lease in ADR-0031 stage 3): what a client of a host that is
// closing sees, on the transport its launcher handed over.
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { isConnectionLoss } from '../src/boundary-wire.js';
import { authenticateHostClient, type HostClient } from '../src/client-connection.js';
import type { HostPlatform } from '../src/ports.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../src/production-platform.js';
import { AGENT_HOST_PROTOCOL_VERSION, HOST_VERSION } from '../src/protocol.js';
import {
  type HostPlatformInitializer,
  type OpenedAgentHost,
  openAgentHost,
} from '../src/runtime.js';
import { connectInProcessClient } from '../src/standalone-host.js';
import { stdioConnection } from '../src/transports.js';
import { scriptedModel, scriptedToolSequence } from './fixtures/scripted-model.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
async function freshRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  return root;
}
/**
 * A host over `root` whose close leaves its clients' transports open, as a host
 * process's close does until it exits: what a client reads during and after the
 * close is what the host sent it.
 */
async function openHost(root: string, platform: HostPlatformInitializer) {
  const host = await openAgentHost(root, platform);
  const clients: HostClient[] = [];
  cleanups.push(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await host.close().catch(() => undefined);
  });
  return {
    connect: async (): Promise<HostClient> => {
      const client = await connectInProcessClient(host, 'public-socket');
      clients.push(client);
      return client;
    },
    host,
  };
}
function heldCatalogPlatform(store: StateStore, entered: () => void, release: Promise<void>) {
  const register = store.workspaceRoots.bind(store);
  vi.spyOn(store, 'workspaceRoots').mockImplementation(async (request) => {
    const reply = await register(request);
    if (request.operation === 'register') {
      entered();
      await release;
    }
    return reply;
  });
  const platform: HostPlatform = {
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    tools: {},
  };
  return platform;
}
/** A host whose workspace-root registration waits for `release`, as a slow admitted write. */
async function openHeldHost(root: string) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const opened = await openHost(root, ({ store }) =>
    heldCatalogPlatform(store, entered.resolve, release.promise)
  );
  // Cleanups run last first: the held write is released before its host closes.
  cleanups.push(async () => release.resolve());
  return { ...opened, entered, release };
}

/** Settles to a flag the test reads while the request may still be in flight. */
function tracked<T>(request: Promise<T>) {
  const state = { settled: false };
  const result = request.finally(() => {
    state.settled = true;
  });
  result.catch(() => undefined);
  return { result, state };
}

/** Starts close and reports, without awaiting, when Core's own retirement joins. */
function retire(host: OpenedAgentHost) {
  const state = { closed: false, coreClosed: false };
  const closing = host.close().then(() => {
    state.closed = true;
  });
  // The same idempotent Core promise the host's close joins.
  const settled = (): void => {
    state.coreClosed = true;
  };
  host.core.close().then(settled, settled);
  return { closing, state };
}

test('a host closing refusal retires client admission while its earlier write still joins', async () => {
  const root = await freshRoot('bs-refused-client-');
  const { connect, entered, host, release } = await openHeldHost(root);
  const client = await connect();
  const other = await connect();
  const registering = client.catalog.workspaceRoots({
    operation: 'register',
    root: { displayName: 'workspace', path: root, preferredId: randomUUID() },
  });
  await entered.promise;
  const closing = host.close();
  const refusal: unknown = await client.catalog
    .workspaceRoots({ operation: 'list' })
    .catch((cause: unknown) => cause);
  expect(refusal).toMatchObject({ code: 'host.closing', failure: { kind: 'refusal' } });
  // Every client's new request is refused the same way, an RPC as a catalog command.
  await expect(other.request('thread/list', {})).rejects.toMatchObject({
    code: 'host.closing',
    failure: { kind: 'refusal' },
  });
  release.resolve();
  await registering;
  await closing;
  // The next catalog command is not written into the transport whose host already
  // refused this client as terminally closing, and neither is an RPC.
  await expect(client.catalog.workspaceRoots({ operation: 'list' })).rejects.toBe(refusal);
  await expect(client.request('thread/list', {})).rejects.toBe(refusal);
});

/**
 * A visible-UI client on the host's private transport. `drop` loses the client's
 * later frames in transit, as frames the host never reads before it exits; `exit`
 * ends the transport as the host process's exit does.
 */
async function attachDroppingClient(host: OpenedAgentHost) {
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  host.bindClientConnection(stdioConnection(toHost, toClient), 'desktop-ui');
  let dropping = false;
  const writes = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (dropping) {
        done();
        return;
      }
      toHost.write(chunk, done);
    },
  });
  const connection = createMessageConnection(
    new StreamMessageReader(toClient),
    new StreamMessageWriter(writes)
  );
  const closed = Promise.withResolvers<void>();
  const exit = (): void => {
    toHost.destroy();
    toClient.destroy();
    connection.dispose();
    closed.resolve();
  };
  const client = await authenticateHostClient(
    connection,
    { hostVersion: HOST_VERSION, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
    async () => exit(),
    closed.promise
  );
  return {
    client,
    drop: () => {
      dropping = true;
    },
    exit,
  };
}

test('a host that exits without answering leaves its unanswered request lost', async () => {
  const root = await freshRoot('bs-unannounced-exit-');
  const { host } = await openHeldHost(root);
  const { client, drop, exit } = await attachDroppingClient(host);
  cleanups.push(async () => exit());
  drop();
  const unread = client.request('thread/list', {}).catch((cause: unknown) => cause);
  exit();
  const failure = await unread;
  expect(isConnectionLoss(failure)).toBe(true);
  expect(failure).toMatchObject({ failure: { code: 'host.connection-lost' } });
});

const modelId = 'gpt-6-sol';
const configuration: RuntimeData = { model: modelId, provider: 'openai' };
const resourceId = 'host-close-fixture';
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Host close proofs make no provider requests');
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

test("a run/start held behind a memory settlement is answered host.closing, joined only as long as Core's own close", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let observations = 0;
  // Ignores abort: the slowest settlement Core's close can join.
  const observer = new MockLanguageModelV4({
    doStream: async () => {
      observations += 1;
      if (observations === 1) {
        entered.resolve();
        await release.promise;
      }
      return scriptedToolSequence([]).doStream({ prompt: [] });
    },
  });
  const root = await freshRoot('bs-host-close-');
  const { connect, host } = await openHost(root, (startup) =>
    createProductionHostPlatform({
      close: async () => undefined,
      memoryResourceIds: [resourceId],
      readConfiguration: async (): Promise<ProductionHostRunConfiguration> => ({
        configuration,
        durableConfiguration: { model: modelId, provider: 'openai' },
        maxSteps: 2,
        memory: {
          native: {
            options: {
              lastMessages: 4,
              observationalMemory: {
                model: observer,
                observation: { bufferTokens: 10, messageTokens: 50_000 },
                reflection: { observationTokens: 40_000 },
                scope: 'thread',
              },
              semanticRecall: false,
              workingMemory: { enabled: false },
            },
          },
          observerModelId: 'openai::gpt-4.1-mini',
          recordPrompt: async () => undefined,
          resourceId,
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
      resolveModel: async () => scriptedToolSequence([]),
      resolveProviderAuth: async () => undefined,
      startup,
    })
  );
  cleanups.push(async () => release.resolve());
  const client = await connect();
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const first = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: `openai::${modelId}`,
    prompt: 'Remember that the launch city is Lisbon and the venue is the riverside hall.',
    threadId,
  });
  await entered.promise;
  await expect
    .poll(async () =>
      (await client.request('thread/read', { fromSeq: 0, threadId })).rows.some(
        ({ event }) => event.type === 'run.finished' && event.runId === first.runId
      )
    )
    .toBe(true);
  const dispatched = Promise.withResolvers<void>();
  const startRun = host.core.startRun.bind(host.core);
  vi.spyOn(host.core, 'startRun').mockImplementation((params, origin) => {
    dispatched.resolve();
    return startRun(params, origin);
  });
  const next = tracked(
    client.request('run/start', {
      commandId: randomUUID(),
      modelId: `openai::${modelId}`,
      prompt: 'Which city did I mention?',
      threadId,
    })
  );
  await dispatched.promise;
  const { closing, state } = retire(host);
  // The admitted request joins the settlement Core's close joins too.
  expect(next.state.settled).toBe(false);
  expect(state.coreClosed).toBe(false);
  release.resolve();
  await expect(next.result).rejects.toMatchObject({ code: 'host.closing' });
  await closing;
  expect(state).toEqual({ closed: true, coreClosed: true });
});

test("a run/stop joining a held owner close answers stopped, joined only as long as Core's own close", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const root = await freshRoot('bs-host-close-');
  const { connect, host } = await openHost(root, {
    close: async () => undefined,
    maxSteps: 3,
    openRun: async (context) => {
      signal = context.signal;
      return {
        close: async () => {
          entered.resolve();
          await release.promise;
        },
      };
    },
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => scriptedModel(),
    tools: {},
  });
  cleanups.push(async () => release.resolve());
  const client = await connect();
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Report completion.',
    threadId,
  });
  await entered.promise;
  const stop = tracked(client.request('run/stop', { commandId: randomUUID(), runId, threadId }));
  // The Stop is admitted: it aborted the run and now joins its held owner.
  await expect.poll(() => signal?.aborted).toBe(true);
  const { closing, state } = retire(host);
  expect(stop.state.settled).toBe(false);
  expect(state.coreClosed).toBe(false);
  release.resolve();
  expect(await stop.result).toEqual({ outcome: 'stopped' });
  await closing;
  expect(state).toEqual({ closed: true, coreClosed: true });
});
