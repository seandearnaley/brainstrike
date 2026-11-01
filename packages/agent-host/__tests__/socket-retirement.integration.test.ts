import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../src/production-platform.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { whenServerCloses } from './fixtures/host-endpoint.js';
import { scriptedModel, scriptedToolSequence } from './fixtures/scripted-model.js';

/**
 * BST-2174: host retirement cancels the in-flight socket requests that read
 * their signal, then joins every admitted request before destroying its socket.
 * Requests whose work Core already joins are answered with no added latency:
 * close waits on that same work, never on the socket alone.
 */

const modelId = 'gpt-6-sol';
const configuration: RuntimeData = { model: modelId, provider: 'openai' };
const resourceId = 'socket-retirement-fixture';
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Socket retirement proofs make no provider requests');
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const hosts: Array<{ client: HostClient; host: AgentHost; root: string }> = [];
afterEach(async () => {
  for (const { client, host, root } of hosts.splice(0)) {
    await client.close();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});

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
function retire(host: AgentHost) {
  const state = { closed: false, coreClosed: false };
  const closing = host.close().then(() => {
    state.closed = true;
  });
  // The same idempotent Core promise the host's Root finalizer joins.
  const settled = (): void => {
    state.coreClosed = true;
  };
  host.core.close().then(settled, settled);
  return { closing, state };
}

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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-socket-retirement-')));
  const host = await startAgentHost({ lifetime: 'persistent', root }, (startup) =>
    createProductionHostPlatform({
      close: async () => undefined,
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
  const client = await attachAgentHost(host.record);
  hosts.push({ client, host, root });
  try {
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
    const transportRetiring = whenServerCloses(host.record.endpoint);
    const { closing, state } = retire(host);
    await transportRetiring;
    // The socket is retiring and its request joins the settlement Core's close joins too.
    expect(next.state.settled).toBe(false);
    expect(state.coreClosed).toBe(false);
    release.resolve();
    await expect(next.result).rejects.toMatchObject({ code: 'host.closing' });
    await closing;
    expect(state).toEqual({ closed: true, coreClosed: true });
  } finally {
    release.resolve();
  }
});

test("a run/stop joining a held owner close answers stopped, joined only as long as Core's own close", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-socket-retirement-')));
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
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
    }
  );
  const client = await attachAgentHost(host.record);
  hosts.push({ client, host, root });
  try {
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
    const transportRetiring = whenServerCloses(host.record.endpoint);
    const { closing, state } = retire(host);
    await transportRetiring;
    expect(stop.state.settled).toBe(false);
    expect(state.coreClosed).toBe(false);
    release.resolve();
    expect(await stop.result).toEqual({ outcome: 'stopped' });
    await closing;
    expect(state).toEqual({ closed: true, coreClosed: true });
  } finally {
    release.resolve();
  }
});
