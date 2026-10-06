import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runWithTimeout } from '@brainstrike/effect-kit';
import {
  decodeHostRecord,
  type HostRecord,
  LiveHostUnavailableError,
  launchHost,
} from '@brainstrike/host-lease';
import { processStartTime, RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import { modelMessageSchema } from 'ai';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostEvent } from '../src/protocol.js';

const Identity = z.strictObject({
  executable: z.string(),
  pid: z.number().int().positive(),
  start: z.string().regex(/^\d+$/),
});
type Identity = z.infer<typeof Identity>;
const FixtureMessage = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('ready'), identity: Identity, record: z.unknown() }),
  z.strictObject({ event: z.literal('failed'), message: z.string(), name: z.string() }),
  z.strictObject({ event: z.literal('child-ready'), identity: Identity }),
  z.strictObject({ event: z.literal('child-joined'), pid: z.number().int().positive() }),
  z.strictObject({ event: z.literal('closed') }),
]);
type FixtureMessage = z.infer<typeof FixtureMessage>;
interface OwnedHost {
  readonly child: ChildProcess;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  closeTask?: Promise<void>;
  expectedExit: number;
  readonly identity: Identity;
  readonly messages: FixtureMessage[];
  readonly stderr: () => string;
}
const hosts: OwnedHost[] = [];
const clients: HostClient[] = [];
const roots: string[] = [];
const tsx = pathToFileURL(
  createRequire(new URL('../../state-store/package.json', import.meta.url)).resolve('tsx')
).href;

async function audit(event: string, fields: Record<string, unknown>): Promise<void> {
  const directory = process.env['M3_WINDOWS_EVIDENCE_DIR'];
  if (directory) {
    await appendFile(
      join(directory, 'fixture-ledger.jsonl'),
      `${JSON.stringify({ event, utc: new Date().toISOString(), ...fields })}\n`
    );
  }
}
function executableOf(pid: number): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; [System.Diagnostics.Process]::GetProcessById(${pid}).MainModule.FileName`,
    ],
    { encoding: 'utf8', windowsHide: true }
  ).trim();
}
function verifyIdentity(identity: Identity): void {
  expect(processStartTime(identity.pid)).toBe(identity.start);
  expect(normalize(executableOf(identity.pid)).toLowerCase()).toBe(
    normalize(identity.executable).toLowerCase()
  );
  expect(normalize(identity.executable).toLowerCase()).toBe(
    normalize(process.execPath).toLowerCase()
  );
}
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-windows-'));
  roots.push(root);
  return root;
}
async function message<T extends FixtureMessage['event']>(
  host: OwnedHost,
  event: T
): Promise<Extract<FixtureMessage, { event: T }>> {
  return runWithTimeout(
    async (signal) =>
      new Promise<Extract<FixtureMessage, { event: T }>>((resolve, reject) => {
        const cleanup = (): void => {
          host.child.off('message', check);
          host.child.off('close', closed);
          signal.removeEventListener('abort', aborted);
        };
        const failed = (cause: unknown): void => {
          cleanup();
          reject(cause);
        };
        const check = (): void => {
          const found = host.messages.find(
            (entry): entry is Extract<FixtureMessage, { event: T }> => entry.event === event
          );
          if (found) {
            cleanup();
            resolve(found);
          } else {
            const failure = host.messages.find((entry) => entry.event === 'failed');
            if (failure?.event === 'failed') {
              failed(new Error(`${failure.name}: ${failure.message}`));
            }
          }
        };
        const closed = (): void =>
          failed(new Error(`Owned host exited before ${event}: ${host.stderr()}`));
        const aborted = (): void => failed(signal.reason);
        host.child.on('message', check);
        host.child.once('close', closed);
        signal.addEventListener('abort', aborted, { once: true });
        check();
      }),
    {
      onTimeout: () => new Error(`Missing fixture message ${event}: ${host.stderr()}`),
      timeoutMs: 10_000,
    }
  );
}
async function spawnHost(
  root: string,
  mode: 'approval' | 'child' = 'approval'
): Promise<OwnedHost> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      tsx,
      fileURLToPath(new URL('./fixtures/windows-host-process.ts', import.meta.url)),
      root,
      mode,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }
  );
  const exit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once('close', (code, signal) => exit.resolve({ code, signal }));
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  const started = Promise.withResolvers<void>();
  child.once('spawn', () => started.resolve());
  child.once('error', (cause) => started.reject(cause));
  await started.promise;
  if (!child.pid) {
    throw new Error('The fixture process has no PID');
  }
  const start = processStartTime(child.pid);
  if (!start) {
    throw new Error(`Fixture process exited before its identity could be read: ${stderr}`);
  }
  const host: OwnedHost = {
    child,
    closed: exit.promise,
    expectedExit: 0,
    identity: { executable: executableOf(child.pid), pid: child.pid, start },
    messages: [],
    stderr: () => stderr,
  };
  hosts.push(host);
  child.on('message', (input: unknown) => host.messages.push(FixtureMessage.parse(input)));
  verifyIdentity(host.identity);
  await audit('host-started', { identity: host.identity, root });
  child.send('start');
  return host;
}
async function startHost(
  root: string,
  mode: 'approval' | 'child' = 'approval'
): Promise<{ host: OwnedHost; record: HostRecord }> {
  const host = await spawnHost(root, mode);
  const ready = await message(host, 'ready');
  expect(ready.identity).toEqual(host.identity);
  const record = decodeHostRecord(ready.record);
  expect(record.pid).toBe(host.identity.pid);
  expect(record.start).toBe(host.identity.start);
  expect(record.endpoint).toMatch(/^\\\\\.\\pipe\\brainstrike-[a-f0-9]+$/);
  expect(record.pid).not.toBe(process.pid);
  return { host, record };
}
async function closeHost(host: OwnedHost): Promise<void> {
  host.closeTask ??= (async () => {
    if (host.child.exitCode === null && host.child.signalCode === null && host.child.connected) {
      host.child.send('close');
    }
    const exit = await runWithTimeout(async () => host.closed, {
      onTimeout: () => new Error(`Owned host ${host.identity.pid} did not join: ${host.stderr()}`),
      timeoutMs: 10_000,
    });
    await audit('host-exited', { identity: host.identity, ...exit });
    expect(exit).toEqual({ code: host.expectedExit, signal: null });
    expect(processStartTime(host.identity.pid)).not.toBe(host.identity.start);
  })();
  await host.closeTask;
}
async function attach(record: HostRecord): Promise<HostClient> {
  const client = await attachAgentHost(record);
  clients.push(client);
  return client;
}
async function event<T extends HostEvent['type']>(
  client: HostClient,
  threadId: string,
  type: T
): Promise<Extract<HostEvent, { type: T }>> {
  let found: Extract<HostEvent, { type: T }> | undefined;
  await expect
    .poll(async () => {
      const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
      found = rows
        .map((row) => row.event)
        .find((entry): entry is Extract<HostEvent, { type: T }> => entry.type === type);
      return found !== undefined;
    })
    .toBe(true);
  if (!found) {
    throw new Error(`The host did not commit ${type}`);
  }
  return found;
}
async function startRun(client: HostClient): Promise<{ runId: string; threadId: string }> {
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'windows-scripted',
    prompt: 'Use the owned fixture effect once.',
    threadId,
  });
  return { runId, threadId };
}

afterEach(async () => {
  const failures: unknown[] = [];
  const clientResults = await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  for (const result of clientResults) {
    if (result.status === 'rejected') {
      failures.push(result.reason);
    }
  }
  for (const host of hosts.splice(0)) {
    try {
      await closeHost(host);
    } catch (cause) {
      failures.push(cause);
    }
  }
  const ownedRoots = roots.splice(0);
  if (failures.length > 0) {
    await audit('cleanup-failed', { failures: failures.length, preservedRoots: ownedRoots });
    throw new AggregateError(
      failures,
      'Windows fixture cleanup failed; owned roots were preserved'
    );
  }
  for (const root of ownedRoots) {
    try {
      expect(RootLock.inspect(root)?.owner.released).toBe(true);
      await expect(readFile(join(root, 'host.json'))).rejects.toThrow();
      await rm(root, { force: true, recursive: true });
      await audit('root-cleaned', { root });
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Windows fixture root cleanup failed');
  }
});

const windowsTest = test.skipIf(process.platform !== 'win32');

windowsTest(
  'a separate authenticated Windows pipe host owns one root and survives client reconnect',
  async () => {
    const root = await freshRoot();
    const { host, record } = await startHost(root);
    const original = await readFile(join(root, 'host.json'), 'utf8');
    await expect(
      attachAgentHost({ ...record, token: randomBytes(32).toString('hex') })
    ).rejects.toThrow('Host authentication failed');
    const client = await attach(record);
    const command = { commandId: randomUUID() };
    const first = await client.request('thread/start', command);
    const rows = (await client.request('thread/read', { fromSeq: 0, threadId: first.threadId }))
      .rows;
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    await client.close();
    verifyIdentity(host.identity);
    const reconnected = await attach(record);
    expect(await reconnected.request('thread/start', command)).toEqual(first);
    expect(
      (await reconnected.request('log/subscribe', { fromSeq: 1, threadId: first.threadId })).rows
    ).toEqual(rows.slice(1));
    await expect(StateStore.open(root)).rejects.toBeInstanceOf(RootLockedError);
    const contender = await spawnHost(root);
    contender.expectedExit = 1;
    expect(await message(contender, 'failed')).toMatchObject({
      message: expect.stringContaining(`pid ${record.pid}`),
      name: 'RootLockedError',
    });
    await closeHost(contender);
    expect(await readFile(join(root, 'host.json'), 'utf8')).toBe(original);
    expect(RootLock.inspect(root)?.owner.pid).toBe(record.pid);
    verifyIdentity(host.identity);
    await audit('reconnect-and-contention-passed', {
      identity: host.identity,
      threadId: first.threadId,
    });
  }
);

windowsTest(
  'an unreachable live Windows owner is refused without spawning, replacing, or terminating it',
  async () => {
    const root = await freshRoot();
    const { host, record } = await startHost(root);
    const unavailable = {
      ...record,
      endpoint: `\\\\.\\pipe\\brainstrike-${randomBytes(16).toString('hex')}`,
    };
    const bytes = JSON.stringify(unavailable);
    await writeFile(join(root, 'host.json'), bytes);
    const owner = RootLock.inspect(root)?.owner;
    let spawned = false;
    let cause: unknown;
    try {
      await launchHost(root, {
        attach: attachAgentHost,
        lifetime: 'cli',
        spawn: async () => {
          spawned = true;
        },
      });
    } catch (error) {
      cause = error;
    }
    expect(cause).toBeInstanceOf(LiveHostUnavailableError);
    expect(cause).toMatchObject({ cause: expect.any(Error), pid: record.pid });
    expect(spawned).toBe(false);
    expect(await readFile(join(root, 'host.json'), 'utf8')).toBe(bytes);
    expect(RootLock.inspect(root)?.owner).toEqual(owner);
    verifyIdentity(host.identity);
    const client = await attach(record);
    await expect(
      client.request('thread/start', { commandId: randomUUID() })
    ).resolves.toHaveProperty('threadId');
    await audit('unavailable-owner-preserved', { identity: host.identity });
  }
);

windowsTest(
  'Windows Stop responds after the owned child physically exits and repeats consistently',
  async () => {
    const root = await freshRoot();
    const { host, record } = await startHost(root, 'child');
    const client = await attach(record);
    const { threadId, runId } = await startRun(client);
    const child = (await message(host, 'child-ready')).identity;
    verifyIdentity(child);
    await audit('effect-child-started', { hostIdentity: host.identity, identity: child });
    const stop = { commandId: randomUUID(), runId, threadId };
    expect(await client.request('run/stop', stop)).toEqual({ outcome: 'stopped' });
    expect(processStartTime(child.pid)).not.toBe(child.start);
    expect(JSON.parse(await readFile(join(root, 'owned-child-joined.json'), 'utf8'))).toEqual({
      joined: true,
      pid: child.pid,
    });
    expect(await message(host, 'child-joined')).toEqual({ event: 'child-joined', pid: child.pid });
    expect(await client.request('run/stop', stop)).toEqual({ outcome: 'stopped' });
    expect((await event(client, threadId, 'run.finished')).outcome).toBe('stopped');
    const rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(rows.filter((row) => row.event.type === 'run.finished')).toHaveLength(1);
    await audit('stop-joined-child', { hostIdentity: host.identity, identity: child, runId });
  }
);

windowsTest(
  'Windows process restart retains committed approvals, deduplicates decisions, and rejects stale discovery',
  async () => {
    const root = await freshRoot();
    const first = await startHost(root);
    const client = await attach(first.record);
    const { threadId, runId } = await startRun(client);
    const pending = await event(client, threadId, 'interaction.requested');
    const before = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    await expect(readFile(join(root, 'permitted.txt'))).rejects.toThrow();
    await closeHost(first.host);
    await client.closed;
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    const second = await startHost(root);
    expect(second.record.token).not.toBe(first.record.token);
    await expect(attachAgentHost({ ...second.record, token: first.record.token })).rejects.toThrow(
      'Host authentication failed'
    );
    await expect(attachAgentHost(first.record)).rejects.toThrow();
    const resumed = await attach(second.record);
    expect((await resumed.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(before);
    const answer = {
      commandId: randomUUID(),
      decision: 'approve' as const,
      interactionId: pending.interactionId,
      runId,
      threadId,
    };
    expect(await resumed.request('interaction/respond', answer)).toEqual({ accepted: true });
    expect((await event(resumed, threadId, 'run.finished')).outcome).toBe('completed');
    expect(await readFile(join(root, 'permitted.txt'), 'utf8')).toBe('one approved Windows effect');
    await closeHost(second.host);
    await resumed.closed;
    const third = await startHost(root);
    const final = await attach(third.record);
    expect(await final.request('interaction/respond', answer)).toEqual({ accepted: true });
    await expect(
      final.request('interaction/respond', { ...answer, commandId: randomUUID() })
    ).rejects.toThrow('stale');
    const rows = (await final.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(rows.filter((row) => row.event.type === 'effect.started')).toHaveLength(1);
    expect(rows.filter((row) => row.event.type === 'effect.finished')).toHaveLength(1);
    expect(rows.filter((row) => row.event.type === 'run.finished')).toHaveLength(1);
    expect(rows.map((row) => row.seq)).toEqual(
      Array.from({ length: rows.length }, (_, index) => index + 1)
    );
    expect(
      (await readFile(join(root, 'effect-count.jsonl'), 'utf8')).trim().split('\n')
    ).toHaveLength(1);
    expect(
      rows.flatMap((row) => (row.event.type === 'interaction.requested' ? [row.event] : []))
    ).toEqual([pending]);
    expect(
      rows.flatMap((row) => (row.event.type === 'interaction.responded' ? [row.event] : []))
    ).toEqual([
      {
        decision: 'approve',
        interactionId: pending.interactionId,
        runId,
        type: 'interaction.responded',
      },
    ]);
    const modelCalls = z
      .array(
        z.strictObject({
          completedToolCallIds: z.array(z.string()),
          pid: z.number().int().positive(),
          step: z.number().int().nonnegative(),
        })
      )
      .parse(
        (await readFile(join(root, 'model-calls.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      );
    expect(modelCalls).toEqual([
      { completedToolCallIds: [], pid: first.host.identity.pid, step: 0 },
      {
        completedToolCallIds: [pending.toolCallId],
        pid: second.host.identity.pid,
        step: 0,
      },
    ]);
    const context = rows
      .flatMap((row) =>
        row.event.type === 'model.messages' || row.event.type === 'model.step'
          ? row.event.messages
          : []
      )
      .map((entry) => modelMessageSchema.parse(entry))
      .flatMap((entry): unknown[] => (typeof entry.content === 'string' ? [] : [...entry.content]));
    expect(context).toContainEqual(
      expect.objectContaining({
        input: pending.input,
        toolCallId: pending.toolCallId,
        toolName: pending.toolId,
        type: 'tool-call',
      })
    );
    expect(context).toContainEqual(
      expect.objectContaining({
        approvalId: pending.interactionId,
        toolCallId: pending.toolCallId,
        type: 'tool-approval-request',
      })
    );
    expect(context).toContainEqual(
      expect.objectContaining({
        approvalId: pending.interactionId,
        approved: true,
        type: 'tool-approval-response',
      })
    );
    expect(context).toContainEqual(
      expect.objectContaining({
        toolCallId: pending.toolCallId,
        toolName: pending.toolId,
        type: 'tool-result',
      })
    );
    await audit('restart-deduplication-passed', {
      identities: [first.host.identity, second.host.identity, third.host.identity],
      runId,
      threadId,
    });
  }
);
