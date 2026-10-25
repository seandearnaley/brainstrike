import { randomUUID } from 'node:crypto';
import { configureLogger } from '@brainstrike/logging';
import { processStartTime } from '@brainstrike/state-store';
import { app } from 'electron';
import { createDesktopHostLease, spawnHostProcess } from '../../host-lease-manager';

// Stdout carries only this fixture's reports; Main's own log lines go to stderr.
configureLogger({ console: { destination: 2 } });
function report(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function describe(cause: unknown): string {
  const parts: string[] = [];
  for (let current = cause, depth = 0; current !== undefined && depth < 5; depth += 1) {
    parts.push(String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(' <- ');
}
const [root, entryPath, platformModule] = process.argv.slice(2);
if (!(root && entryPath && platformModule)) {
  throw new Error('The host child proof requires a root, an entry and a platform module');
}
let host: { readonly pid: number; readonly start: string } | undefined;
const owner = createDesktopHostLease({
  entryPath,
  platformModule,
  root,
  spawn: (entry, args, env) => {
    const child = spawnHostProcess(entry, args, env);
    const pid = child.pid;
    const start = pid === undefined ? null : processStartTime(pid);
    if (pid !== undefined && start !== null) {
      host = { pid, start };
    }
    return child;
  },
});
let closing: Promise<void> | undefined;
function close(): void {
  closing ??= owner.close().then(() => {
    report({ event: 'closed' });
    app.quit();
  });
  closing.catch((cause: unknown) => {
    report({ event: 'failed', message: describe(cause) });
    app.exit(1);
  });
}
process.on('message', (command: unknown) => {
  if (command !== 'close') {
    throw new TypeError('Invalid Electron fixture control');
  }
  close();
});
app.on('window-all-closed', () => undefined);
app
  .whenReady()
  .then(async () => {
    const client = await owner.acquire();
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    report({ event: 'attached', host, threadId });
  })
  .catch((cause: unknown) => {
    report({ event: 'failed', message: describe(cause) });
    close();
  });
