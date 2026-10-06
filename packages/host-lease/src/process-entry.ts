import { ForeignLockError, RootLockedError } from '@brainstrike/state-store';
import { decodeStartOptions, type HostRuntime, startHost } from './runtime.js';
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
  const controller = new AbortController();
  let host: HostRuntime | undefined;
  let ready = false;
  const stop = (): void => {
    controller.abort(new Error('Host process cancelled'));
    host?.close().catch((cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    });
  };
  const cancelled = (input: unknown): void => {
    if (
      input &&
      typeof input === 'object' &&
      'event' in input &&
      input.event === 'cancel-startup'
    ) {
      stop();
    }
  };
  const disconnected = (): void => {
    if (!ready) {
      stop();
    }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('message', cancelled);
  process.on('disconnect', disconnected);
  try {
    const options = decodeStartOptions(JSON.parse(process.argv[2] ?? 'null'));
    host = await startHost(options, undefined, controller.signal);
    controller.signal.throwIfAborted();
    ready = true;
    await report({ event: 'ready' });
    await host.closed;
  } finally {
    await host?.close();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    process.off('message', cancelled);
    process.off('disconnect', disconnected);
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
