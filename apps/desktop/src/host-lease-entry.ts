import {
  decodeStartOptions,
  type HostRuntime,
  type StartupMessage,
  startHost,
} from '@brainstrike/host-lease';
import { ForeignLockError, RootLockedError } from '@brainstrike/state-store';
import { decodeHostLeaseControl, decodeHostLeaseParentMessage } from './host-lease-control';

async function main(): Promise<void> {
  const parent = process.parentPort;
  if (!parent) {
    throw new Error('Host lease utility has no Electron parent channel');
  }
  let host: HostRuntime | undefined;
  let stopRequested = false;
  let controlFailure: unknown;
  const stop = (): void => {
    stopRequested = true;
    host?.close().catch((cause: unknown) => {
      process.stderr.write(`${String(cause)}\n`);
      process.exitCode = 1;
    });
  };
  const message = (input: unknown): void => {
    try {
      decodeHostLeaseControl(decodeHostLeaseParentMessage(input).data);
      stop();
    } catch (cause) {
      controlFailure = cause;
      stop();
    }
  };
  parent.on('message', message);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const options = decodeStartOptions(JSON.parse(process.argv[2] ?? 'null'));
    host = await startHost(options);
    if (stopRequested) {
      await host.close();
    } else {
      parent.postMessage({ event: 'ready' } satisfies StartupMessage);
    }
    await host.closed;
    if (controlFailure !== undefined) {
      throw controlFailure;
    }
  } catch (cause) {
    parent.postMessage({
      event: 'failed',
      kind:
        cause instanceof RootLockedError
          ? 'root-locked'
          : cause instanceof ForeignLockError
            ? 'foreign-lock'
            : 'error',
      message: cause instanceof Error ? cause.message : String(cause),
    } satisfies StartupMessage);
    throw cause;
  } finally {
    parent.off('message', message);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await host?.close();
  }
}
// Electron's parent channel keeps this utility alive after the lease is closed.
// Exit only after main's finally has joined host.close and removed its listeners.
void main().then(
  () => process.exit(0),
  (cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`, () => process.exit(1));
  }
);
