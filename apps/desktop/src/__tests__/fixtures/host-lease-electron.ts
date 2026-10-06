import { app, utilityProcess } from 'electron';
import { createDesktopHostLease } from '../../host-lease-manager';

function report(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
const root = process.argv[2];
const entryPath = process.argv[3];
if (!(root && entryPath)) {
  throw new Error('Electron host lease test requires explicit root and entry path');
}
const startupTimeoutMs = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
let ownPid: number | undefined;
const owner = createDesktopHostLease({
  entryPath,
  fork: (entry, args) => {
    const child = utilityProcess.fork(entry, [...args]);
    child.once('spawn', () => {
      ownPid = child.pid;
    });
    return child;
  },
  platformModule: process.env['BRAINSTRIKE_M3_OWNED_PLATFORM_MODULE'],
  root,
  startupTimeoutMs,
});
let closing: Promise<void> | undefined;
function close(): void {
  closing ??= owner.close().then(() => {
    report({ event: 'closed' });
    app.exit(0);
  });
  closing.catch((cause: unknown) => {
    report({ event: 'failed', message: String(cause) });
    app.exit(1);
  });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  if (chunk.trim() === 'close') {
    close();
  }
});
app.on('window-all-closed', () => undefined);
app
  .whenReady()
  .then(async () => {
    const attachment = await owner.acquire();
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
