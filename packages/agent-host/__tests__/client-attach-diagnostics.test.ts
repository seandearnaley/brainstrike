import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRecord } from '@brainstrike/host-lease';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { attachAgentHost } from '../src/client.js';
import { AGENT_HOST_PROTOCOL_VERSION } from '../src/protocol.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(holdInitialize = false) {
  const root = await mkdtemp(join(tmpdir(), 'bst-attach-'));
  const record: HostRecord = {
    endpoint:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\brainstrike-${randomBytes(12).toString('hex')}`
        : join(root, 's'),
    hostVersion: '0.1.0',
    pid: process.pid,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: 'disposable-start-identity',
    token: randomBytes(32).toString('hex'),
  };
  const initialized = {
    hostVersion: record.hostVersion,
    pid: record.pid,
    protocolVersion: record.protocolVersion,
    start: record.start,
  };
  const release = Promise.withResolvers<typeof initialized>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const connection = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket)
    );
    socket.once('close', () => {
      connection.dispose();
      sockets.delete(socket);
    });
    connection.onRequest('initialize', (params) => {
      expect(params.token).toBe(record.token);
      return holdInitialize ? release.promise : initialized;
    });
    connection.listen();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(record.endpoint, resolve);
  });
  return {
    async close() {
      release.resolve(initialized);
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(root, { force: true, recursive: true });
    },
    record,
  };
}

test.each([false, true])(
  'real socket authentication emits only opt-in, secret-free phase evidence (enabled=%s)',
  async (enabled) => {
    vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', enabled ? '1' : undefined);
    const captured: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      captured.push(String(chunk));
      return true;
    });
    const host = await fixture();
    try {
      const client = await attachAgentHost(host.record);
      await client.close();
      const logs = captured.filter((line) => line.startsWith('[host-attach-proof] '));
      if (!enabled) {
        expect(logs).toEqual([]);
        return;
      }
      const phases = logs.map((line) => JSON.parse(line.slice('[host-attach-proof] '.length)));
      expect(phases.map((event) => event.phase)).toEqual(
        expect.arrayContaining([
          'socket-connect',
          'socket-connected',
          'initialize-send',
          'initialize-reply',
          'attach-succeeded',
        ])
      );
      expect(logs.join('')).not.toContain(host.record.token);
      expect(logs.join('')).not.toContain(host.record.endpoint);
      expect(logs.join('')).not.toContain(host.record.start);
      expect(phases[0]).toMatchObject({ hostPid: process.pid, timeoutMs: 1500 });
      expect(phases[0].processPid).toBe(process.pid);
      expect(phases[0].monotonicMs).toBeTypeOf('number');
    } finally {
      await host.close();
    }
  }
);

test('a held initialize keeps the original deadline rejection and identifies the stalled phase', async () => {
  vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', '1');
  const captured: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    captured.push(String(chunk));
    return true;
  });
  const host = await fixture(true);
  try {
    await expect(attachAgentHost(host.record, 80)).rejects.toThrow(
      `Host pid ${process.pid} initialize/attach timed out`
    );
    const phases = captured
      .filter((line) => line.startsWith('[host-attach-proof] '))
      .map((line) => JSON.parse(line.slice('[host-attach-proof] '.length)));
    expect(phases.map((event) => event.phase)).toContain('initialize-send');
    expect(phases.map((event) => event.phase)).not.toContain('initialize-reply');
    expect(phases.find((event) => event.phase === 'attach-timeout')).toMatchObject({
      timeoutMs: 80,
    });
  } finally {
    await host.close();
  }
});
