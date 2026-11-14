import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { whenServerCloses } from './fixtures/host-endpoint.js';
import { scriptedModel } from './fixtures/scripted-model.js';

/**
 * BST-2174: host retirement cancels the in-flight socket requests that read
 * their signal, then joins every admitted request before destroying its socket.
 * Requests whose work Core already joins are answered with no added latency:
 * close waits on that same work, never on the socket alone.
 */

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

test("a run/stop joining a held admission close answers stopped, joined only as long as Core's own close", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-socket-retirement-')));
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      admitRun: async (request) => {
        signal = request.signal;
        return {
          close: async () => {
            entered.resolve();
            await release.promise;
          },
          configuration: {},
          model: scriptedModel(),
          snapshot: { configuration: {}, maxSteps: 3, toolIdentities: {} },
          tools: {},
        };
      },
      close: async () => undefined,
      maxSteps: 3,
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
    // The Stop is admitted: it aborted the run and now joins its held admission.
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
