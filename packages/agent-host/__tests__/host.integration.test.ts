import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MessageChannel } from 'node:worker_threads';
import {
  DEFAULT_PERMISSION_POLICIES,
  type PermissionToolGateSnapshot,
} from '@brainstrike/assistant-contract';
import { BLOB_MIN_BYTES, RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import { toStandardSchema } from '@mastra/core/schema';
import type { JSONSchema7 } from 'ai';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { authenticateHostClient } from '../src/client-connection.js';
import { bindHostConnection } from '../src/connection.js';
import type { HostPlatform, HostTool } from '../src/ports.js';
import type { HostEvent, HostLogRow } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { nodePortConnection, stdioConnection } from '../src/transports.js';
import { parallelToolModel, scriptedModel } from './fixtures/scripted-model.js';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
async function setup(
  policy: PermissionToolGateSnapshot = {
    policies: { ...DEFAULT_PERMISSION_POLICIES },
    yolo: false,
  },
  toolOverride?: HostTool
): Promise<{
  root: string;
  host: AgentHost;
  client: HostClient;
  model: MockLanguageModelV4;
  platform: HostPlatform;
}> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-host-'));
  roots.push(root);
  const model = scriptedModel('write_file');
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => policy,
    resolveModel: async (id) => {
      if (id !== 'scripted') {
        throw new Error('Unknown model');
      }
      return model;
    },
    tools: {
      write_file: toolOverride ?? {
        description: 'Write an owned fixture file',
        execute: async (input) => {
          const parsed = z.object({ text: z.string() }).parse(input);
          await writeFile(join(root, 'permitted.txt'), parsed.text);
          return { path: join(root, 'permitted.txt') };
        },
        identity: 'native-fixture-generation-1',
        inputSchema: z.object({ text: z.string() }),
        risk: 'edit',
      },
    },
  };
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  return { client, host, model, platform, root };
}
async function start(client: HostClient): Promise<{ threadId: string; runId: string }> {
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  await client.request('log/subscribe', { fromSeq: 0, threadId });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Use the fixture tool, then report the result.',
    threadId,
  });
  return { runId, threadId };
}
async function event<T extends HostEvent['type']>(
  client: HostClient,
  threadId: string,
  type: T
): Promise<Extract<HostEvent, { type: T }>> {
  let found: Extract<HostEvent, { type: T }> | undefined;
  await expect
    .poll(async () => {
      const result = await client.request('thread/read', { fromSeq: 0, threadId });
      found = result.rows
        .map((row) => row.event)
        .find((item): item is Extract<HostEvent, { type: T }> => item.type === type);
      return found !== undefined;
    })
    .toBe(true);
  if (!found) {
    throw new Error('Expected host event was not committed');
  }
  return found;
}

test('authenticated socket clients see committed SQLite rows and one approved real native effect', async () => {
  const { root, client, host, model } = await setup();
  const observed: HostLogRow[] = [];
  client.onEvent((row) => observed.push(row));
  const { threadId, runId } = await start(client);
  const pending = await event(client, threadId, 'interaction.requested');
  await expect(readFile(join(root, 'permitted.txt'), 'utf8')).rejects.toThrow();
  await client.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: pending.interactionId,
    runId,
    threadId,
  });
  expect((await event(client, threadId, 'run.finished')).outcome).toBe('completed');
  expect(await readFile(join(root, 'permitted.txt'), 'utf8')).toBe(
    'written by permitted host tool'
  );
  const rows = await host.core.read(threadId, 0);
  expect(rows.filter((row) => row.event.type === 'effect.started')).toHaveLength(1);
  expect(rows.filter((row) => row.event.type === 'effect.finished')).toHaveLength(1);
  expect(rows.map((row) => row.seq)).toEqual(
    Array.from({ length: rows.length }, (_, index) => index + 1)
  );
  expect(
    observed.every((row) =>
      rows.some((stored) => stored.seq === row.seq && stored.event.type === row.event.type)
    )
  ).toBe(true);
  expect(model.doStreamCalls).toHaveLength(2);
  await expect(StateStore.open(root)).rejects.toBeInstanceOf(RootLockedError);
});

test('deny and explicit policy deny under YOLO cannot execute the native tool', async () => {
  const { root, client } = await setup();
  const { threadId, runId } = await start(client);
  const pending = await event(client, threadId, 'interaction.requested');
  await client.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'deny',
    interactionId: pending.interactionId,
    runId,
    threadId,
  });
  await event(client, threadId, 'run.finished');
  await expect(readFile(join(root, 'permitted.txt'))).rejects.toThrow();
  expect(
    (await client.request('thread/read', { fromSeq: 0, threadId })).rows.some(
      (row) => row.event.type === 'effect.started'
    )
  ).toBe(false);
  const denied = await setup({
    policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'deny' },
    sessionGrants: ['edit'],
    yolo: true,
  });
  const deniedRun = await start(denied.client);
  await event(denied.client, deniedRun.threadId, 'run.finished');
  await expect(readFile(join(denied.root, 'permitted.txt'))).rejects.toThrow();
});

test('logical commands deduplicate, conflicting reuse and stale/wrong-run decisions fail', async () => {
  const { client } = await setup();
  const params = { commandId: randomUUID() };
  const first = await client.request('thread/start', params);
  expect(await client.request('thread/start', params)).toEqual(first);
  await expect(
    client.request('run/start', {
      commandId: params.commandId,
      modelId: 'scripted',
      prompt: 'test',
      threadId: first.threadId,
    })
  ).rejects.toThrow();
  const { threadId, runId } = await start(client);
  const pending = await event(client, threadId, 'interaction.requested');
  await expect(
    client.request('interaction/respond', {
      commandId: randomUUID(),
      decision: 'approve',
      interactionId: pending.interactionId,
      runId: randomUUID(),
      threadId,
    })
  ).rejects.toThrow();
  const answer = {
    commandId: randomUUID(),
    decision: 'approve' as const,
    interactionId: pending.interactionId,
    runId,
    threadId,
  };
  await client.request('interaction/respond', answer);
  expect(await client.request('interaction/respond', answer)).toEqual({ accepted: true });
  await expect(
    client.request('interaction/respond', { ...answer, commandId: randomUUID() })
  ).rejects.toThrow();
  await event(client, threadId, 'run.finished');
});

test('client loss leaves the host run alive, reconnect catches up, Stop joins and releases the root', async () => {
  const { root, client, host } = await setup();
  const { threadId, runId } = await start(client);
  await event(client, threadId, 'interaction.requested');
  const before = (await client.request('thread/read', { fromSeq: 0, threadId })).rows.at(-1)!.seq;
  await client.close();
  const rejoined = await attachAgentHost(host.record);
  clients.push(rejoined);
  expect(
    (await rejoined.request('log/subscribe', { fromSeq: before - 1, threadId })).rows[0]?.seq
  ).toBe(before);
  const stop = { commandId: randomUUID(), runId, threadId };
  expect(await rejoined.request('run/stop', stop)).toEqual({ outcome: 'stopped' });
  expect(await rejoined.request('run/stop', stop)).toEqual({ outcome: 'stopped' });
  expect((await event(rejoined, threadId, 'run.finished')).outcome).toBe('stopped');
  await expect(readFile(join(root, 'permitted.txt'))).rejects.toThrow();
  await host.close();
  await rejoined.closed;
  expect(RootLock.inspect(root)?.owner.released).toBe(true);
  await expect(readFile(join(root, 'host.json'))).rejects.toThrow();
});

test('a bad token never attaches or starts a run', async () => {
  const { host } = await setup();
  await expect(attachAgentHost({ ...host.record, token: 'f'.repeat(64) })).rejects.toThrow();
  expect(host.clientCount).toBe(1);
});

test('MessagePort and stdio dispatch the same authenticated schema into the same host/store', async () => {
  const { host } = await setup();
  const channel = new MessageChannel();
  const server = nodePortConnection(channel.port1);
  bindHostConnection(server, host.core, host.record, () => undefined);
  const portClosed = Promise.withResolvers<void>();
  channel.port2.once('close', () => portClosed.resolve());
  const portClient = await authenticateHostClient(
    nodePortConnection(channel.port2),
    host.record,
    async () => {
      channel.port2.close();
      channel.port1.close();
      server.dispose();
      await portClosed.promise;
    },
    portClosed.promise
  );
  clients.push(portClient);
  const { threadId } = await portClient.request('thread/start', { commandId: randomUUID() });
  const input = new PassThrough();
  const output = new PassThrough();
  const stdioServer = stdioConnection(input, output);
  bindHostConnection(stdioServer, host.core, host.record, () => undefined);
  const stdioClosed = Promise.withResolvers<void>();
  const stdioClient = await authenticateHostClient(
    stdioConnection(output, input),
    host.record,
    async () => {
      input.destroy();
      output.destroy();
      stdioServer.dispose();
      stdioClosed.resolve();
    },
    stdioClosed.promise
  );
  clients.push(stdioClient);
  const { rows } = await stdioClient.request('thread/read', { fromSeq: 0, threadId });
  expect(rows.map((row) => row.event.type)).toEqual(['command.accepted', 'thread.started']);
  expect(rows).toEqual(await host.core.read(threadId, 0));
});

test('restart continues an unanswered approval and deduplicates its accepted response without effect replay', async () => {
  const { root, host, client, platform, model } = await setup();
  const { threadId, runId } = await start(client);
  const pending = await event(client, threadId, 'interaction.requested');
  await host.close();
  const resumed = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(resumed);
  const next = await attachAgentHost(resumed.record);
  clients.push(next);
  const decision = {
    commandId: randomUUID(),
    decision: 'approve' as const,
    interactionId: pending.interactionId,
    runId,
    threadId,
  };
  await next.request('interaction/respond', decision);
  const finished = await event(next, threadId, 'run.finished');
  expect(finished.outcome, JSON.stringify(finished)).toBe('completed');
  expect(await readFile(join(root, 'permitted.txt'), 'utf8')).toBe(
    'written by permitted host tool'
  );
  expect(model.doStreamCalls).toHaveLength(2);
  await resumed.close();
  const again = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(again);
  const final = await attachAgentHost(again.record);
  clients.push(final);
  expect(await final.request('interaction/respond', decision)).toEqual({ accepted: true });
  const { rows } = await final.request('thread/read', { fromSeq: 0, threadId });
  expect(rows.filter((row) => row.event.type === 'effect.started')).toHaveLength(1);
  expect(rows.filter((row) => row.event.type === 'effect.finished')).toHaveLength(1);
});

test('Stop acknowledges only after the dispatched native child has physically exited', async () => {
  const started = Promise.withResolvers<number>();
  let exited = false;
  const native: HostTool = {
    description: 'Run an owned child',
    execute: async (_input, context) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        signal: context.signal,
        stdio: 'ignore',
      });
      child.once('spawn', () => {
        if (child.pid) {
          started.resolve(child.pid);
        }
      });
      await new Promise<void>((resolve, reject) => {
        child.once('error', (cause) => {
          if (!context.signal.aborted) {
            reject(cause);
          }
        });
        child.once('close', () => {
          exited = true;
          resolve();
        });
      });
      return { joined: true };
    },
    identity: 'owned-process-fixture-1',
    inputSchema: z.object({ text: z.string() }),
    risk: 'read',
  };
  const { client } = await setup(undefined, native);
  const { threadId, runId } = await start(client);
  const pid = await started.promise;
  expect(process.kill(pid, 0)).toBe(true);
  expect(await client.request('run/stop', { commandId: randomUUID(), runId, threadId })).toEqual({
    outcome: 'stopped',
  });
  expect(exited).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
  expect((await event(client, threadId, 'run.finished')).outcome).toBe('stopped');
});

test('host/stop replies after the owned native child and Root join, then closes every client', async () => {
  const started = Promise.withResolvers<number>();
  let exited = false;
  const native: HostTool = {
    description: 'Run an owned child through host shutdown',
    execute: async (_input, context) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        signal: context.signal,
        stdio: 'ignore',
      });
      child.once('spawn', () => {
        if (child.pid) {
          started.resolve(child.pid);
        }
      });
      await new Promise<void>((resolve, reject) => {
        child.once('error', (cause) => {
          if (!context.signal.aborted) {
            reject(cause);
          }
        });
        child.once('close', () => {
          exited = true;
          resolve();
        });
      });
      return { joined: true };
    },
    identity: 'owned-host-stop-process-fixture-1',
    inputSchema: z.object({ text: z.string() }),
    risk: 'read',
  };
  const { client, root, host } = await setup(undefined, native);
  const other = await attachAgentHost(host.record);
  clients.push(other);
  await start(client);
  const pid = await started.promise;
  expect(process.kill(pid, 0)).toBe(true);
  expect(await client.request('host/stop', {})).toEqual({
    outcome: 'stopped',
    rootReleased: true,
  });
  expect(exited).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(RootLock.inspect(root)?.owner.released).toBe(true);
  await expect(readFile(join(root, 'host.json'))).rejects.toThrow();
  const contender = await RootLock.acquire(root);
  await contender.release();
  await Promise.all([client.closed, other.closed, host.closed]);
});

test('host/stop client loss retains Root until the held platform join settles', async () => {
  const entered = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<void>();
  const { root, client, host, platform } = await setup();
  platform.close = async () => {
    entered.resolve();
    await joined.promise;
  };
  const request = client.request('host/stop', {});
  request.catch(() => undefined);
  try {
    await entered.promise;
    await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
    await client.close();
    await expect(request).rejects.toThrow();
    await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
  } finally {
    joined.resolve();
  }
  await host.closed;
  expect(RootLock.inspect(root)?.owner.released).toBe(true);
  const contender = await RootLock.acquire(root);
  await contender.release();
});

test('host/stop fences later commands while the platform join is pending', async () => {
  const entered = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<void>();
  const { root, client, host, platform } = await setup();
  platform.close = async () => {
    entered.resolve();
    await joined.promise;
  };
  const request = client.request('host/stop', {});
  try {
    await entered.promise;
    await expect(client.request('thread/start', { commandId: randomUUID() })).rejects.toThrow(
      /closing/
    );
    await expect(client.request('host/stop', {})).rejects.toThrow(/closing/);
    await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
  } finally {
    joined.resolve();
  }
  expect(await request).toEqual({ outcome: 'stopped', rootReleased: true });
  await host.closed;
});

test('host/stop reports cleanup failure and retains Root instead of reporting release', async () => {
  const { root, client, host, platform } = await setup();
  const store = host.core.store;
  if (!(store instanceof StateStore)) {
    throw new Error('Shutdown fixture did not acquire its real SQLite store');
  }
  platform.close = async () => {
    throw new Error('Owned fixture cleanup failed');
  };
  try {
    await expect(client.request('host/stop', {})).rejects.toThrow(/cleanup failed/i);
    await expect(host.closed).rejects.toThrow();
    await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
  } finally {
    // This fixture platform acquired no external resources. Retain the failed
    // production close result, then release only the test's owned SQLite root.
    await store.close();
    hosts.splice(hosts.indexOf(host), 1);
  }
});

// Tool output wide enough to cross the store's spool boundary, owned here and
// sized from the production threshold. Reading a live repository document for
// these bytes made the premise hostage to unrelated prose edits: #3598
// condensed docs/agents/assistant-runtime.md from 193 KB to 3.4 KB and this
// proof went red without the spool path changing at all.
test('large tool content is spooled before publication and survives host reopen with model history', async () => {
  const paragraph =
    'The host owns the run loop; every client observes the committed rows. ' +
    'A spooled row keeps its identity while its body moves to a blob \u2014 caf\u00e9, na\u00efve, \u65e5\u672c\u8a9e.\n';
  const text = paragraph.repeat(Math.ceil((BLOB_MIN_BYTES * 2) / Buffer.byteLength(paragraph)));
  expect(Buffer.byteLength(text)).toBeGreaterThan(BLOB_MIN_BYTES);
  const native: HostTool = {
    description: 'Return the owned wide document',
    execute: async () => ({ text }),
    identity: 'native-owned-document-reader',
    inputSchema: z.object({ text: z.string() }),
    risk: 'read',
  };
  const { root, client, host, platform } = await setup(undefined, native);
  const { threadId } = await start(client);
  await event(client, threadId, 'run.finished');
  const output = await event(client, threadId, 'effect.finished');
  expect(output.output).toEqual({ text });
  const stored = await host.core.store.read(threadId);
  const spooled = stored.filter((row) => typeof row.event['blob'] === 'string');
  expect(spooled.length).toBeGreaterThan(0);
  expect(spooled.every((row) => Buffer.byteLength(row.raw) < BLOB_MIN_BYTES)).toBe(true);
  for (const row of spooled) {
    expect(
      Buffer.byteLength(await readFile(join(root, 'blobs', String(row.event['blob'])), 'utf8'))
    ).toBe(row.event['bytes']);
  }
  const committed = await client.request('thread/read', { fromSeq: 0, threadId });
  await host.close();
  const freshModel = scriptedModel();
  const reopened = await startAgentHost(
    { lifetime: 'persistent', root },
    { ...platform, resolveModel: async () => freshModel }
  );
  hosts.push(reopened);
  const next = await attachAgentHost(reopened.record);
  clients.push(next);
  expect(await next.request('thread/read', { fromSeq: 0, threadId })).toEqual(committed);
  await next.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Use the preceding document result.',
    threadId,
  });
  await expect
    .poll(
      async () =>
        (await next.request('thread/read', { fromSeq: 0, threadId })).rows.filter(
          (row) => row.event.type === 'run.finished'
        ).length
    )
    .toBe(2);
  expect(JSON.stringify(freshModel.doStreamCalls[0]?.prompt)).toContain(
    JSON.stringify(text).slice(1, -1)
  );
});

test('restart uses a fresh model with committed approval context and executes the native effect once', async () => {
  const { root, client, host, platform } = await setup();
  const { threadId, runId } = await start(client);
  const pending = await event(client, threadId, 'interaction.requested');
  await host.close();
  const freshModel = scriptedModel('write_file');
  const reopened = await startAgentHost(
    { lifetime: 'persistent', root },
    { ...platform, resolveModel: async () => freshModel }
  );
  hosts.push(reopened);
  const next = await attachAgentHost(reopened.record);
  clients.push(next);
  await next.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: pending.interactionId,
    runId,
    threadId,
  });
  const finished = await event(next, threadId, 'run.finished');
  expect(finished.outcome, JSON.stringify(finished)).toBe('completed');
  expect(freshModel.doStreamCalls).toHaveLength(1);
  const rows = (await next.request('thread/read', { fromSeq: 0, threadId })).rows;
  expect(rows.filter((row) => row.event.type === 'effect.started')).toHaveLength(1);
  const context = rows
    .filter((row) => row.event.type === 'model.messages')
    .flatMap((row) => (row.event.type === 'model.messages' ? row.event.messages : []));
  expect(JSON.stringify(context)).toContain(
    JSON.stringify(join(root, 'permitted.txt')).slice(1, -1)
  );
});

test('parallel SDK calls retain both approvals and two clients answer without duplicate native execution', async () => {
  const { root, host, client, platform } = await setup();
  await host.close();
  const model = parallelToolModel('write_file');
  const parallelHost = await startAgentHost(
    { lifetime: 'persistent', root },
    { ...platform, resolveModel: async () => model }
  );
  hosts.push(parallelHost);
  const first = await attachAgentHost(parallelHost.record);
  clients.push(first);
  const second = await attachAgentHost(parallelHost.record);
  clients.push(second);
  const { threadId, runId } = await start(first);
  await expect
    .poll(
      async () =>
        (await first.request('thread/read', { fromSeq: 0, threadId })).rows.filter(
          (row) => row.event.type === 'interaction.requested'
        ).length
    )
    .toBe(2);
  const pending = (await first.request('thread/read', { fromSeq: 0, threadId })).rows.flatMap(
    (row) => (row.event.type === 'interaction.requested' ? [row.event] : [])
  );
  const a = pending[0];
  const b = pending[1];
  if (!(a && b)) {
    throw new Error('Parallel approvals were not committed');
  }
  await first.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: a.interactionId,
    runId,
    threadId,
  });
  await expect(readFile(join(root, 'permitted.txt'))).rejects.toThrow();
  await second.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: b.interactionId,
    runId,
    threadId,
  });
  expect((await event(first, threadId, 'run.finished')).outcome).toBe('completed');
  const rows = (await first.request('thread/read', { fromSeq: 0, threadId })).rows;
  expect(rows.filter((row) => row.event.type === 'effect.started')).toHaveLength(2);
  expect(rows.filter((row) => row.event.type === 'effect.finished')).toHaveLength(2);
  expect(model.doStreamCalls).toHaveLength(2);
  await client.close();
});

test('a final permitted call completes at the existing model-step limit without another model request', async () => {
  const { root, host, client, platform } = await setup();
  await host.close();
  const model = scriptedModel('write_file');
  const limited = await startAgentHost(
    { lifetime: 'persistent', root },
    { ...platform, maxSteps: 1, resolveModel: async () => model }
  );
  hosts.push(limited);
  const next = await attachAgentHost(limited.record);
  clients.push(next);
  const { threadId, runId } = await start(next);
  const pending = await event(next, threadId, 'interaction.requested');
  await next.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: pending.interactionId,
    runId,
    threadId,
  });
  expect((await event(next, threadId, 'run.finished')).outcome).toBe('completed');
  expect(await readFile(join(root, 'permitted.txt'), 'utf8')).toBe(
    'written by permitted host tool'
  );
  expect(model.doStreamCalls).toHaveLength(1);
  await client.close();
});

test('canonical Standard Schema and model projection survive SDK approval without changing the committed native result', async () => {
  const schema: JSONSchema7 = {
    $defs: { text: { minLength: 1, type: 'string' } },
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { optional: { type: 'string' }, text: { $ref: '#/$defs/text' } },
    required: ['text'],
    type: 'object',
  };
  let executed = 0;
  const { root, client, model } = await setup(undefined, {
    description: 'Existing native executor with a canonical MCP schema',
    execute: async (input) => {
      const { text } = z.object({ text: z.string() }).parse(input);
      executed += 1;
      return { bytes: Buffer.byteLength(text), executions: executed, text };
    },
    identity: 'existing-executable-schema-binding',
    inputSchema: toStandardSchema(schema),
    risk: 'edit',
    strict: false,
    toModelOutput: ({ output }) => {
      const { bytes } = z.object({ bytes: z.number() }).parse(output);
      return { type: 'json', value: { bytes } };
    },
  });
  const ids = await start(client);
  const pending = await event(client, ids.threadId, 'interaction.requested');
  expect(executed).toBe(0);
  await client.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: pending.interactionId,
    ...ids,
  });
  await event(client, ids.threadId, 'run.finished');
  expect(executed).toBe(1);
  const definition = model.doStreamCalls[0]?.tools?.find(
    (tool) => tool.type === 'function' && tool.name === 'write_file'
  );
  expect(definition).toMatchObject({ inputSchema: schema, strict: false });
  const result = await event(client, ids.threadId, 'effect.finished');
  const { bytes } = z
    .object({ bytes: z.number(), executions: z.literal(1), text: z.string() })
    .parse(result.output);
  expect(
    model.doStreamCalls[1]?.prompt.flatMap((message) =>
      message.role === 'tool' ? message.content : []
    )
  ).toContainEqual({
    output: { type: 'json', value: { bytes } },
    toolCallId: pending.toolCallId,
    toolName: pending.toolId,
    type: 'tool-result',
  });
  await expect(StateStore.open(root)).rejects.toBeInstanceOf(RootLockedError);
});
