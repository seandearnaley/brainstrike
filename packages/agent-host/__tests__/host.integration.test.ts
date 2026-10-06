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
import { RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
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
import { scriptedModel } from './fixtures/scripted-model.js';

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

test('restart retains an unanswered approval and deduplicates its accepted response without model/effect replay', async () => {
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
  expect((await event(next, threadId, 'run.finished')).outcome).toBe('interrupted');
  expect(await readFile(join(root, 'permitted.txt'), 'utf8')).toBe(
    'written by permitted host tool'
  );
  expect(model.doStreamCalls).toHaveLength(1);
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
