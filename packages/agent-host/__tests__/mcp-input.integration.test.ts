import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMcpElicitationResult } from '@brainstrike/agent/mcp-client';
import {
  DEFAULT_PERMISSION_POLICIES,
  type McpElicitationPresentationWire,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform, HostTool } from '../src/ports.js';
import type { HostParams } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const root of roots.splice(0)) {
    const guard = await RootLock.acquire(root);
    await guard.release();
    await rm(root, { force: true, recursive: true });
  }
});

async function rootFilesContain(root: string, sentinel: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && (await rootFilesContain(path, sentinel))) {
      return true;
    }
    if (entry.isFile() && (await readFile(path)).includes(Buffer.from(sentinel))) {
      return true;
    }
  }
  return false;
}

async function setup(mode: 'form' | 'url' = 'form', uncertain = false, beforeBind?: Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-mcp-input-'));
  roots.push(root);
  const secret = `synthetic-private-${randomUUID()}`;
  const serverId = parseConfiguredMcpServerId('recorded.server');
  const ready = Promise.withResolvers<void>();
  const response = Promise.withResolvers<unknown>();
  response.promise.catch(() => undefined);
  const model = scriptedModel('mcp_fixture');
  const presentationId = randomUUID();
  const taskHandle = {
    authorityEpoch: randomUUID(),
    principalId: 'none',
    resource: 'http://127.0.0.1:1/mcp',
    serverId,
    taskId: 'recorded-task-1',
  };
  const formRequest = {
    method: 'elicitation/create',
    params: {
      message: secret,
      mode: 'form',
      requestedSchema: {
        properties: { workspace: { default: secret, type: 'string' } },
        required: ['workspace'],
        type: 'object',
      },
    },
  } satisfies Parameters<typeof validateMcpElicitationResult>[0];
  const urlRequest = {
    method: 'elicitation/create',
    params: {
      elicitationId: presentationId,
      message: secret,
      mode: 'url',
      url: `https://example.invalid/capability/${secret}`,
    },
  } satisfies Parameters<typeof validateMcpElicitationResult>[0];
  const request = mode === 'form' ? formRequest : urlRequest;
  const provenance = {
    configuredProtocol: '2026-07-28',
    configuredServerId: serverId,
    generation: 7,
    invocationId: randomUUID(),
    negotiatedRevision: '2026-07-28',
    operation: { type: 'tools/call' },
    requestId: 'recorded-request-1',
    taskHandle,
    transport: 'streamable-http',
  } as const;
  const presentation: McpElicitationPresentationWire =
    mode === 'form'
      ? {
          id: presentationId,
          message: secret,
          mode,
          provenance,
          requestedSchema: formRequest.params.requestedSchema,
        }
      : { id: presentationId, message: secret, mode, provenance, url: urlRequest.params.url };
  const delivered: unknown[] = [];
  let current = true;
  let aborted = false;
  const assertCurrent = async (): Promise<void> => {
    if (!current) {
      throw new Error(secret);
    }
  };
  const tool: HostTool = {
    description: 'Recorded native elicitation callback',
    execute: async (_input, context) => {
      const abort = (): void => {
        aborted = true;
        response.reject(new Error('Recorded native caller aborted'));
      };
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        if (!context.mcp) {
          throw new Error('Native execution has no Core binding');
        }
        await beforeBind;
        await context.mcp.bindTask({ assertCurrent, handle: taskHandle });
        await context.mcp.requestInput({
          assertCurrent,
          presentation,
          settle: async (answer) => {
            delivered.push(structuredClone(answer));
            response.resolve({ accepted: true });
            if (uncertain) {
              throw new Error(secret);
            }
            return 'local-finalized';
          },
          signal: context.signal,
          validate: async (answer) => validateMcpElicitationResult(request, answer),
        });
        ready.resolve();
        return await response.promise;
      } finally {
        context.signal.removeEventListener('abort', abort);
      }
    },
    identity: 'recorded-executor-7',
    inputSchema: z.object({ text: z.string() }),
    mcpAuthority: {
      auth: { type: 'none' },
      destination: taskHandle.resource,
      extensions: { apps: true, tasks: true },
      kind: 'http',
      protocol: '2026-07-28',
      transport: 'streamable-http',
      version: 1,
    },
    mcpBinding: { configuredServerId: serverId, generation: 7 },
    risk: 'mcp',
  };
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, mcp: 'allow' },
      yolo: true,
    }),
    resolveModel: async () => model,
    tools: { mcp_fixture: tool },
  };
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Use the recorded native elicitation.',
    threadId,
  });
  if (!beforeBind) {
    await ready.promise;
  }
  const input = { interactionId: presentationId, runId, threadId };
  const settle = { ...input, action: 'accept', commandId: randomUUID() } as const;
  return {
    aborted: () => aborted,
    client,
    delivered,
    host,
    input,
    model,
    platform,
    retire: () => {
      current = false;
    },
    root,
    secret,
    settle,
  };
}

test('FULL native binding/request/intent commits precede one parked SDK resolution and values never enter SQLite/WAL/replay', async () => {
  const fixture = await setup();
  const { client, delivered, host, input, model, root, secret, settle } = fixture;
  const before = await client.request('thread/read', { fromSeq: 0, threadId: input.threadId });
  expect(before.rows.filter((row) => row.event.type === 'mcp.task.bound')).toHaveLength(1);
  expect(before.rows.filter((row) => row.event.type === 'mcp.input.requested')).toHaveLength(1);
  expect(
    before.rows.some(
      (row) => row.event.type === 'interaction.requested' || row.event.type === 'model.step'
    )
  ).toBe(false);
  const ephemeral = await client.request('mcp/input/read', input);
  expect(ephemeral.status).toBe('requested');
  expect(JSON.stringify(ephemeral.presentation).includes(secret)).toBe(true);
  const full = vi.spyOn(host.core.store, 'append');
  await client.request('mcp/input/stage', { ...input, content: { workspace: secret } });
  expect(delivered).toHaveLength(0);
  await client.request('mcp/input/settle', settle);
  await expect
    .poll(async () => (await client.request('mcp/input/read', input)).status)
    .toBe('local-finalized');
  const committed = full.mock.calls.find(([items]) =>
    items.some((item) => item.event['type'] === 'mcp.input.intent')
  );
  expect(committed?.[2]).toBe('full');
  await expect
    .poll(async () =>
      (await client.request('thread/read', { fromSeq: 0, threadId: input.threadId })).rows.some(
        (row) => row.event.type === 'run.finished'
      )
    )
    .toBe(true);
  expect(delivered).toHaveLength(1);
  expect(model.doStreamCalls).toHaveLength(2);
  expect((await client.request('mcp/input/settle', settle)).status).toBe('local-finalized');
  expect(delivered).toHaveLength(1);
  const rows = await host.core.read(input.threadId, 0);
  expect(JSON.stringify(rows).includes(secret)).toBe(false);
  expect(await rootFilesContain(root, secret)).toBe(false);
  full.mockRestore();
  await host.close();
  const reopened = await startAgentHost({ lifetime: 'persistent', root }, fixture.platform);
  hosts.push(reopened);
  const reader = await attachAgentHost(reopened.record);
  clients.push(reader);
  const replay = await reader.request('mcp/input/read', input);
  expect(replay.status).toBe('local-finalized');
  expect(replay.presentation).toBeUndefined();
  expect((await reader.request('mcp/input/settle', settle)).status).toBe('local-finalized');
  expect(delivered).toHaveLength(1);
});

test('first valid stage is immutable and belongs to the exact authenticated connection', async () => {
  const { client, delivered, host, input, secret, settle } = await setup();
  const other = await attachAgentHost(host.record);
  clients.push(other);
  await client.request('mcp/input/stage', { ...input, content: { workspace: secret } });
  await client.request('mcp/input/stage', { ...input, content: { workspace: secret } });
  await expect(
    client.request('mcp/input/stage', { ...input, content: { workspace: 'different' } })
  ).rejects.toThrow();
  await expect(
    other.request('mcp/input/stage', { ...input, content: { workspace: secret } })
  ).rejects.toThrow();
  await expect(other.request('mcp/input/settle', settle)).rejects.toThrow();
  await expect(
    client.request('mcp/input/stage', {
      ...input,
      content: { workspace: secret },
      runId: randomUUID(),
    })
  ).rejects.toThrow();
  expect(delivered).toHaveLength(0);
  await client.request('mcp/input/settle', settle);
  await expect.poll(() => delivered.length).toBe(1);
  await expect(other.request('mcp/input/settle', settle)).rejects.toThrow();
});

test('pure native validator and strict safe settlement suppress secret-bearing errors and extra values', async () => {
  const { client, delivered, input, secret, settle } = await setup();
  const invalid = await client
    .request('mcp/input/stage', { ...input, content: { workspace: secret, [secret]: secret } })
    .catch((error: unknown) => error);
  expect(JSON.stringify(invalid).includes(secret)).toBe(false);
  expect(invalid).toBeInstanceOf(Error);
  const unexpected = {
    ...settle,
    content: { workspace: secret },
  } as HostParams<'mcp/input/settle'>;
  const rejected = await client
    .request('mcp/input/settle', unexpected)
    .catch((error: unknown) => error);
  expect(rejected).toBeInstanceOf(Error);
  expect(JSON.stringify(rejected).includes(secret)).toBe(false);
  expect(delivered).toHaveLength(0);
  await client.request('mcp/input/stage', { ...input, content: { workspace: secret } });
  await client.request('mcp/input/settle', settle);
});

test('FULL commit failure sends zero answers and retains the native pending capability for a fresh command', async () => {
  const { client, delivered, host, input, secret, settle } = await setup();
  await client.request('mcp/input/stage', { ...input, content: { workspace: secret } });
  const original = host.core.store.append.bind(host.core.store);
  const fault = vi
    .spyOn(host.core.store, 'append')
    .mockImplementation((items, commandId, durability) => {
      if (items.some((item) => item.event['type'] === 'mcp.input.intent')) {
        throw new Error('Forced native FULL commit failure');
      }
      return original(items, commandId, durability);
    });
  await expect(client.request('mcp/input/settle', settle)).rejects.toThrow();
  expect(delivered).toHaveLength(0);
  expect((await client.request('mcp/input/read', input)).status).toBe('requested');
  fault.mockRestore();
  await expect(client.request('mcp/input/settle', settle)).rejects.toThrow();
  expect(delivered).toHaveLength(0);
  await client.request('mcp/input/settle', { ...settle, commandId: randomUUID() });
  await expect.poll(() => delivered.length).toBe(1);
});

test('connection loss erases its staged answer and generation loss refuses native delivery', async () => {
  const { client, delivered, host, input, secret, settle, retire } = await setup();
  await client.request('mcp/input/stage', { ...input, content: { workspace: secret } });
  await client.close();
  const other = await attachAgentHost(host.record);
  clients.push(other);
  await expect(other.request('mcp/input/settle', settle)).rejects.toThrow();
  await other.request('mcp/input/stage', { ...input, content: { workspace: secret } });
  retire();
  const error = await other.request('mcp/input/settle', settle).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(JSON.stringify(error).includes(secret)).toBe(false);
  expect(delivered).toHaveLength(0);
});

test('a response lost after native resolution stays unknown and repeated command never resends', async () => {
  const { client, delivered, input, secret, settle } = await setup('form', true);
  await client.request('mcp/input/stage', { ...input, content: { workspace: secret } });
  await client.request('mcp/input/settle', settle);
  await expect
    .poll(async () => (await client.request('mcp/input/read', input)).status)
    .toBe('unknown');
  expect((await client.request('mcp/input/settle', settle)).status).toBe('unknown');
  expect(delivered).toHaveLength(1);
});

test('settlement write failure is unknown live and after reopen and fails the joined run without resending', async () => {
  const fixture = await setup();
  const { client, delivered, host, input, root, secret, settle } = fixture;
  const original = host.core.store.append.bind(host.core.store);
  const fault = vi
    .spyOn(host.core.store, 'append')
    .mockImplementation((items, commandId, durability) => {
      if (items.some((item) => item.event['type'] === 'mcp.input.settled')) {
        throw new Error(secret);
      }
      return original(items, commandId, durability);
    });
  await client.request('mcp/input/stage', { ...input, content: { workspace: secret } });
  await client.request('mcp/input/settle', settle);
  await expect
    .poll(async () =>
      (await host.core.read(input.threadId, 0)).some((row) => row.event.type === 'run.finished')
    )
    .toBe(true);
  const rows = await host.core.read(input.threadId, 0);
  expect(rows.filter((row) => row.event.type === 'mcp.input.intent')).toHaveLength(1);
  expect(rows.filter((row) => row.event.type === 'mcp.input.settled')).toHaveLength(0);
  const finished = rows.find((row) => row.event.type === 'run.finished');
  expect(finished?.event).toMatchObject({ outcome: 'failed', type: 'run.finished' });
  if (finished?.event.type !== 'run.finished') {
    throw new Error('Missing joined run outcome');
  }
  expect(finished.event.detail).toEqual(expect.any(String));
  expect(JSON.stringify(rows).includes(secret)).toBe(false);
  const live = await client.request('mcp/input/read', input);
  expect(live.status).toBe('unknown');
  expect(live.presentation).toBeUndefined();
  expect((await client.request('mcp/input/settle', settle)).status).toBe('unknown');
  await expect(
    client.request('mcp/input/settle', { ...settle, commandId: randomUUID() })
  ).rejects.toThrow();
  expect(delivered).toHaveLength(1);
  expect(await rootFilesContain(root, secret)).toBe(false);
  fault.mockRestore();
  await host.close();
  const reopened = await startAgentHost({ lifetime: 'persistent', root }, fixture.platform);
  hosts.push(reopened);
  const reader = await attachAgentHost(reopened.record);
  clients.push(reader);
  const replay = await reader.request('mcp/input/read', input);
  expect(replay.status).toBe('unknown');
  expect(replay.presentation).toBeUndefined();
  expect((await reader.request('mcp/input/settle', settle)).status).toBe('unknown');
  expect(delivered).toHaveLength(1);
});

test('URL capabilities stay ephemeral while accept without form content resolves the parked native caller', async () => {
  const { client, delivered, host, input, root, secret, settle } = await setup('url');
  await client.request('mcp/input/stage', input);
  await client.request('mcp/input/settle', settle);
  await expect.poll(() => delivered.length).toBe(1);
  expect(JSON.stringify(await host.core.read(input.threadId, 0)).includes(secret)).toBe(false);
  expect(await rootFilesContain(root, secret)).toBe(false);
});

test('Stop joins a native callback that reaches Core admission after Stop has fenced its run', async () => {
  const gate = Promise.withResolvers<void>();
  const { client, host, input, aborted, delivered } = await setup('form', false, gate.promise);
  await expect
    .poll(async () =>
      (await host.core.read(input.threadId, 0)).some((row) => row.event.type === 'effect.started')
    )
    .toBe(true);
  const stopping = client.request('run/stop', {
    commandId: randomUUID(),
    runId: input.runId,
    threadId: input.threadId,
  });
  await expect.poll(aborted).toBe(true);
  gate.resolve();
  expect((await stopping).outcome).toBe('stopped');
  expect(delivered).toHaveLength(0);
  const rows = await host.core.read(input.threadId, 0);
  expect(rows.filter((row) => row.event.type === 'mcp.task.bound')).toHaveLength(0);
  expect(rows.filter((row) => row.event.type === 'run.finished')).toHaveLength(1);
});
