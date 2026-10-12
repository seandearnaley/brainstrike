import { app, MessageChannelMain, type MessagePortMain, utilityProcess } from 'electron';
import { createDesktopProfileRuntime } from '../../desktop-profile-runtime';
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
  getAuthority: unused,
  getFileInvalidator: () => undefined,
  installQueryTarget: () => {},
  profile: createDesktopProfileRuntime(() => owner),
});
let closing: Promise<void> | undefined;
function close(): void {
  closing ??= runtime.retireProfile().then(() => {
    report({ event: 'closed' });
    app.exit(0);
  });
  closing.catch((cause: unknown) => {
    report({ event: 'failed', message: String(cause) });
    app.exit(1);
  });
}
// BST-1977: the Windows fixture lost stdin controls after attachment. Use
// Node's inherited IPC channel for this fixture's control lane.
process.on('message', (command: unknown) => {
  if (command === 'close') {
    close();
  } else if (command === 'release-lifetime') {
    for (const end of lifetimeEnds.splice(0)) {
      end.close();
    }
    report({ event: 'lifetime-released' });
  } else {
    throw new TypeError('Invalid Electron fixture control');
  }
});
app.on('window-all-closed', () => undefined);
app
  .whenReady()
  .then(async () => {
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
