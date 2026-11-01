import { configureLogger } from '@brainstrike/logging';
import { app, MessageChannelMain, type MessagePortMain, utilityProcess } from 'electron';
import { createDesktopProfileRuntime } from '../../desktop-profile-runtime';
import { createDesktopHostLease } from '../../host-lease-manager';
import { createHostProfileAdmission } from '../../host-profile-admission';

// Stdout carries only this fixture's reports, as the agent host keeps it for its framing: Main's
// own log lines (a startup stall warning among them) go to stderr.
configureLogger({ console: { destination: 2 } });
function report(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
/** A failure with its cause chain: a refusal's message alone does not say what refused. */
function describe(cause: unknown): string {
  const parts: string[] = [];
  for (let current = cause, depth = 0; current !== undefined && depth < 5; depth += 1) {
    parts.push(String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(' <- ');
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
const startupTimeoutArg = process.argv[4];
const platformModule = process.env['BRAINSTRIKE_M3_OWNED_PLATFORM_MODULE'];
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
  ...(platformModule === undefined ? {} : { platformModule }),
  root,
  ...(startupTimeoutArg === undefined ? {} : { startupTimeoutMs: Number(startupTimeoutArg) }),
});
const profile = createDesktopProfileRuntime(() => owner);
const admission = createHostProfileAdmission(profile);
let closing: Promise<void> | undefined;
function close(): void {
  closing ??= admission.retire().then(() => {
    report({ event: 'closed' });
    // Quit as the product does: app.exit tears Electron down without joining its
    // utility children, and a refused host still exiting then crashed it (0xC0000005).
    app.quit();
  });
  closing.catch((cause: unknown) => {
    report({ event: 'failed', message: describe(cause) });
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
    const [attachment, concurrent] = await Promise.all([admission.acquire(), admission.acquire()]);
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
    report({ event: 'failed', message: describe(cause) });
    close();
  });
