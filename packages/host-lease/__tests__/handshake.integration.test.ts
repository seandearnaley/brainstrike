import { mkdtemp, rm } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithTimeout } from '@brainstrike/effect-kit';
import { expect, test } from 'vitest';
import { destroySocket, receiveFrames } from '../src/frames.js';
import { decodeReply, type HostRecord, type HostReply } from '../src/record.js';
import { startHost } from '../src/runtime.js';

async function rawReply(record: HostRecord, wire: string): Promise<HostReply> {
  const socket = new Socket();
  try {
    return await runWithTimeout(
      (signal) =>
        new Promise<HostReply>((resolve, reject) => {
          const abort = (): void => {
            socket.destroy();
            reject(signal.reason);
          };
          receiveFrames(
            socket,
            decodeReply,
            (reply) => {
              signal.removeEventListener('abort', abort);
              resolve(reply);
            },
            reject
          );
          socket.once('error', reject);
          socket.once('close', () => {
            signal.removeEventListener('abort', abort);
            reject(new Error('Host closed before reply'));
          });
          signal.addEventListener('abort', abort, { once: true });
          socket.connect(record.endpoint, () => socket.write(wire));
        }),
      { onTimeout: () => new Error('Raw handshake timed out'), timeoutMs: 1500 }
    );
  } finally {
    await destroySocket(socket);
  }
}

test('server rejects attach before initialize, version mismatch, extra fields and oversized frames without admitting a client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-handshake-'));
  const host = await startHost({ lifetime: 'persistent', root });
  const initialize = {
    hostVersion: host.record.hostVersion,
    method: 'initialize',
    protocolVersion: host.record.protocolVersion,
    token: host.record.token,
  };
  try {
    const requests = [
      { method: 'attach' },
      { ...initialize, protocolVersion: initialize.protocolVersion + 1 },
      { ...initialize, hostVersion: 'incompatible' },
      { ...initialize, ignored: true },
    ];
    for (const request of requests) {
      expect((await rawReply(host.record, `${JSON.stringify(request)}\n`)).method).toBe('error');
      expect(host.clientCount).toBe(0);
    }
    expect((await rawReply(host.record, 'x'.repeat(8193))).method).toBe('error');
    expect(host.clientCount).toBe(0);
  } finally {
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});
