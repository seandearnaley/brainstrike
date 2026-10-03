import { type QueryProcess, queryHostEntryPath } from './process.js';
import type { QueryRequest } from './protocol.js';

/** Electron's documented surface, injected to keep this library Node-only. */
export interface QueryUtilityProcess {
  readonly kill: () => boolean;
  readonly off: {
    (event: 'message', listener: (message: unknown) => void): unknown;
    (event: 'exit', listener: () => void): unknown;
    (event: 'error', listener: (error: Error) => void): unknown;
  };
  readonly on: {
    (event: 'message', listener: (message: unknown) => void): unknown;
    (event: 'exit', listener: () => void): unknown;
    (event: 'error', listener: (error: Error) => void): unknown;
  };
  readonly postMessage: (message: QueryRequest) => void;
}

export function spawnUtilityQueryProcess(
  fork: (entryPath: string) => QueryUtilityProcess
): QueryProcess {
  const host = fork(queryHostEntryPath('utility'));
  let exited = false;
  const observeExit = (): void => {
    exited = true;
    host.off('exit', observeExit);
  };
  host.on('exit', observeExit);
  return {
    kill: (): void => {
      if (!(exited || host.kill())) {
        throw new Error('Could not kill the owned SQLite query utility process.');
      }
    },
    onError: (listener): (() => void) => {
      host.on('error', listener);
      return () => {
        host.off('error', listener);
      };
    },
    onExit: (listener): (() => void) => {
      if (exited) {
        queueMicrotask(listener);
      } else {
        host.on('exit', listener);
      }
      return () => {
        host.off('exit', listener);
      };
    },
    onMessage: (listener): (() => void) => {
      host.on('message', listener);
      return () => {
        host.off('message', listener);
      };
    },
    postMessage: (message): void => {
      host.postMessage(message);
    },
  };
}
