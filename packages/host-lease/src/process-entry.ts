import { ForeignLockError, RootLockedError } from '@brainstrike/state-store';
import { decodeStartOptions, startHost } from './runtime.js';
import type { StartupMessage } from './startup-message.js';

async function report(message: StartupMessage): Promise<void> {
  if (!(process.send && process.connected)) {
    throw new Error('Host startup has no parent IPC channel');
  }
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error: Error | null) => (error ? reject(error) : resolve()));
  });
}
async function main(): Promise<void> {
  const options = decodeStartOptions(JSON.parse(process.argv[2] ?? 'null'));
  const host = await startHost(options);
  const stop = (): void => {
    host.close().catch((cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await report({ event: 'ready' });
    await host.closed;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await host.close();
  }
}
main().catch(async (cause: unknown) => {
  process.exitCode = 1;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (process.connected) {
    try {
      await report({
        event: 'failed',
        kind:
          cause instanceof RootLockedError
            ? 'root-locked'
            : cause instanceof ForeignLockError
              ? 'foreign-lock'
              : 'error',
        message,
      });
    } catch (reportCause) {
      process.stderr.write(`Host failure report failed: ${String(reportCause)}\n`);
    }
  }
  process.stderr.write(`${message}\n`);
});
