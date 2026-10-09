import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMcpAppToolInvocationResult,
  DEFAULT_PERMISSION_POLICIES,
  MCP_APPS_MIME_TYPE,
} from '@brainstrike/assistant-contract';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostMcpAppToolCall, HostPlatform } from '../src/ports.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const root of roots.splice(0)) {
    const guard = await RootLock.acquire(root);
    await guard.release();
    await rm(root, { force: true, recursive: true });
  }
});

const app = {
  mimeType: MCP_APPS_MIME_TYPE,
  resourceUri: 'ui://counter/app.html',
  serverId: 'counter',
  toolName: 'increment',
} as const;

/** A host thread whose model call of `counter.increment` committed the app it mounts. */
async function mountedApp(
  callAppTool: (call: HostMcpAppToolCall, signal: AbortSignal) => Promise<unknown>
) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-mcp-app-'));
  roots.push(root);
  let mcp: 'allow' | 'ask' = 'allow';
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 3,
    mcp: { callAppTool },
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, mcp },
      yolo: false,
    }),
    resolveModel: async () => scriptedModel('counter_increment'),
    tools: {
      counter_increment: {
        description: 'Increment the counter and show it in its app',
        // The MCP runtime's own marker producer, as an app tool's result commits.
        execute: async () =>
          createMcpAppToolInvocationResult(app, { content: [{ text: 'count 1', type: 'text' }] }),
        identity: 'counter-generation-1',
        inputSchema: z.object({ text: z.string() }),
        permissionToolId: 'counter.increment',
        risk: 'mcp',
      },
    },
  };
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Open the counter.',
    threadId,
  });
  await expect
    .poll(async () =>
      (await client.request('thread/read', { fromSeq: 0, threadId })).rows.some(
        ({ event }) => event.type === 'run.finished'
      )
    )
    .toBe(true);
  const call = { app, arguments: { source: 'app' }, threadId, toolName: 'increment' };
  return { ask: () => (mcp = 'ask'), call, client };
}

test("Core decides an app's call under the thread's live policy and runs an asked one only once approved", async () => {
  const runs: HostMcpAppToolCall[] = [];
  const { ask, call, client } = await mountedApp(async (request) => {
    runs.push(request);
    return { content: [{ text: 'count 2', type: 'text' }] };
  });
  await expect(client.request('mcp/app/admit', call)).resolves.toEqual({
    decision: 'allow',
    riskCategory: 'mcp',
  });
  ask();
  await expect(client.request('mcp/app/admit', call)).resolves.toEqual({
    decision: 'ask',
    riskCategory: 'mcp',
  });
  await expect(client.request('mcp/app/call', { ...call, approved: false })).rejects.toThrow(
    'This MCP App tool call needs the user’s approval'
  );
  expect(runs).toEqual([]);
  await expect(client.request('mcp/app/call', { ...call, approved: true })).resolves.toEqual({
    result: { content: [{ text: 'count 2', type: 'text' }] },
  });
  expect(runs).toEqual([
    { arguments: { source: 'app' }, serverId: 'counter', toolName: 'increment' },
  ]);
});

test("a client's cancelled app call aborts the host's server call", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const { call, client } = await mountedApp(
    (_request, signal) =>
      new Promise((_resolve, reject) => {
        started.resolve(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
  );
  const controller = new AbortController();
  const pending = client.request('mcp/app/call', { ...call, approved: false }, controller.signal);
  const signal = await started.promise;
  expect(signal.aborted).toBe(false);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(signal.aborted).toBe(true);
});
