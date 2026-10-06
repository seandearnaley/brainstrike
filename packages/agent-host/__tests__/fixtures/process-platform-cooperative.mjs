import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import { processStartTime } from '@brainstrike/state-store';
import { z } from 'zod';
import { recordFixtureEvent } from './owned-fixture-process.ts';
import { createHostPlatform as createRecordedPlatform } from './process-platform.mjs';

const Control = z.strictObject({
  endpoint: z.string().min(1),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
const Close = z.strictObject({
  event: z.literal('close'),
  pid: z.number().int().positive(),
  start: z.string().regex(/^\d+$/),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Test-only platform wrapper; no production host/lease protocol is extended.
 * @param {import('@brainstrike/host-lease').HostStartOptions} options
 * @param {import('../../src/runtime.js').HostStartupContext} context
 * @returns {Promise<import('../../src/ports.js').HostPlatform>}
 */
export async function createHostPlatform(options, context) {
  const encoded = process.env.BRAINSTRIKE_M3_FIXTURE_CLOSE_CONTROL;
  if (!encoded) {
    throw new Error('Missing private fixture close control');
  }
  const control = Control.parse(JSON.parse(encoded));
  const start = processStartTime(process.pid);
  recordFixtureEvent('fixture-platform-owner', {
    arguments: process.argv,
    identity: { executable: process.execPath, pid: process.pid, start },
    node: process.versions.node,
    root: options.root,
  });
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    let received = '';
    socket.on('data', (value) => {
      received += value;
      if (!received.includes('\n')) {
        return;
      }
      try {
        const command = Close.parse(JSON.parse(received.trim()));
        if (
          command.pid !== process.pid ||
          command.start !== start ||
          !timingSafeEqual(Buffer.from(command.token, 'hex'), Buffer.from(control.token, 'hex'))
        ) {
          socket.destroy();
          return;
        }
        // The production entry already accepts this parent-channel cancellation.
        // Emit it only after the fixture connection physically closes, allowing
        // the context-owned server finalizer to join without retaining a client.
        socket.once('close', () => process.emit('message', { event: 'cancel-startup' }));
        socket.end('accepted\n');
      } catch {
        socket.destroy();
      }
    });
  });
  await context.register(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    if (server.listening) {
      await new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      );
    }
  });
  context.signal.throwIfAborted();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(control.endpoint, done);
  });
  return createRecordedPlatform(options, context);
}
