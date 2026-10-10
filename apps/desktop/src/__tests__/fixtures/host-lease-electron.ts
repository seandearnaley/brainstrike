import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { processStartTime } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { app, MessageChannelMain, type MessagePortMain, utilityProcess } from 'electron';
import { createDesktopHostLease } from '../../host-lease-manager';
import { createNativeIndexRuntime } from '../../native-index-runtime';

function report(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
const root = process.argv[2];
const entryPath = process.argv[3];
if (!(root && entryPath)) {
  throw new Error('Electron host lease test requires explicit root and entry path');
}
report({
  event: 'profile',
  profile: { sessionData: app.getPath('sessionData'), userData: app.getPath('userData') },
});
const startupTimeoutMs = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
let ownPid: number | undefined;
// Main's end of each host's lifetime channel, so a live Main can let its host go.
const lifetimeEnds: MessagePortMain[] = [];
const owner = createDesktopHostLease({
  entryPath,
  fork: (entry, args) => {
    const child = utilityProcess.fork(entry, [...args]);
    child.once('spawn', () => {
      ownPid = child.pid;
    });
    return child;
  },
  lifetimeChannel: () => {
    const channel = new MessageChannelMain();
    lifetimeEnds.push(channel.port1);
    return channel;
  },
  platformModule: process.env['BRAINSTRIKE_M3_OWNED_PLATFORM_MODULE'],
  root,
  startupTimeoutMs,
});
const unused = (): Promise<never> => Promise.reject(new Error('No index requested by this client'));
const runtime = createNativeIndexRuntime({
  closeQueries: async () => {},
  createIndexOwner: unused,
  createProfileOwner: () => owner,
  getAuthority: unused,
  getFileInvalidator: () => undefined,
  installQueryTarget: () => {},
});
let closing: Promise<void> | undefined;
let controlServer: Server | undefined;
const controlSockets = new Set<Socket>();
async function closeControlPipe(): Promise<void> {
  const server = controlServer;
  if (!server?.listening) {
    return;
  }
  const socketsClosed = [...controlSockets].map(
    (socket) => new Promise<void>((done) => socket.once('close', done))
  );
  for (const socket of controlSockets) {
    socket.destroy();
  }
  await new Promise<void>((done, reject) => {
    server.close((cause) => (cause ? reject(cause) : done()));
  });
  await Promise.all(socketsClosed);
}
function close(): void {
  closing ??= runtime.retireProfile().then(async () => {
    await closeControlPipe();
    report({ event: 'closed' });
    app.exit(0);
  });
  closing.catch((cause: unknown) => {
    report({ event: 'failed', message: String(cause) });
    app.exit(1);
  });
}
function releaseLifetime(): void {
  for (const end of lifetimeEnds.splice(0)) {
    end.close();
  }
  report({ event: 'lifetime-released' });
}
const decodeControl = makeThrowingDecoder(
  Schema.Struct({ endpoint: Schema.String, token: Schema.String }),
  { onExcessProperty: 'error' }
);
const decodeCommand = makeThrowingDecoder(
  Schema.Struct({
    event: Schema.String,
    pid: Schema.Finite,
    start: Schema.String,
    token: Schema.String,
  }),
  { onExcessProperty: 'error' }
);
function bindControlPipe(): Promise<void> {
  const encoded = process.env['BRAINSTRIKE_M3_ELECTRON_FIXTURE_CONTROL'];
  if (!encoded) {
    throw new Error('Windows Electron fixture requires its private control');
  }
  const control = decodeControl(JSON.parse(encoded));
  if (!/^[a-f0-9]{64}$/u.test(control.token)) {
    throw new Error('Invalid private Electron fixture control token');
  }
  const start = processStartTime(process.pid);
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    controlSockets.add(socket);
    socket.once('close', () => controlSockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    let received = '';
    let handled = false;
    socket.on('data', (value: string) => {
      received += value;
      if (handled || !received.includes('\n')) {
        return;
      }
      handled = true;
      try {
        const command = decodeCommand(JSON.parse(received.trim()));
        if (
          (command.event !== 'close' && command.event !== 'release-lifetime') ||
          command.pid !== process.pid ||
          command.start !== start ||
          !/^[a-f0-9]{64}$/u.test(command.token) ||
          !timingSafeEqual(Buffer.from(command.token, 'hex'), Buffer.from(control.token, 'hex'))
        ) {
          throw new Error('Private Electron fixture control did not match Main identity');
        }
        if (command.event === 'close') {
          socket.once('close', close);
        } else {
          releaseLifetime();
        }
        socket.end('accepted\n');
      } catch {
        report({
          event: 'failed',
          message: 'Malformed or unauthenticated Electron fixture control rejected',
        });
        socket.end('rejected\n');
      }
    });
  });
  controlServer = server;
  return new Promise<void>((ready, reject) => {
    server.once('error', reject);
    server.listen(control.endpoint, ready);
  });
}
// Windows Electron intentionally supplies an EOF stdin stream (PR #3543).
// https://github.com/electron/electron/blob/v44.4.5/lib/common/init.ts
// Retain this private fixture transport until supported Windows Electron accepts stdin.
const controlsReady = process.platform === 'win32' ? bindControlPipe() : Promise.resolve();
if (process.platform !== 'win32') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    if (chunk.trim() === 'close') {
      close();
    }
    if (chunk.trim() === 'release-lifetime') {
      releaseLifetime();
    }
  });
}
app.on('window-all-closed', () => undefined);
app
  .whenReady()
  .then(async () => {
    await controlsReady;
    const [attachment, concurrent] = await Promise.all([
      runtime.acquireProfile(),
      runtime.acquireProfile(),
    ]);
    if (attachment !== concurrent) {
      throw new Error('Profile clients acquired different host attachments');
    }
    report({
      event: 'attached',
      owned: ownPid === attachment.record.pid,
      record: attachment.record,
    });
  })
  .catch((cause: unknown) => {
    report({ event: 'failed', message: String(cause) });
    close();
  });
