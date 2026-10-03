import { type QueryProcess, queryHostEntryPath } from './process.js';
import type { QueryRequest } from './protocol.js';

/** Electron's documented surface, injected to keep this library Node-only. */
export interface QueryUtilityProcess {
  readonly kill: () => boolean;
  readonly off: {
    (event: 'message', listener: (message: unknown) => void): unknown;
    (event: 'exit', listener: () => void): unknown;
    (event: 'error', listener: (type: string, location: string, report: string) => void): unknown;
  };
  readonly on: {
    (event: 'message', listener: (message: unknown) => void): unknown;
    (event: 'exit', listener: () => void): unknown;
    (event: 'error', listener: (type: string, location: string, report: string) => void): unknown;
  };
  readonly postMessage: (message: QueryRequest) => void;
}

export function spawnUtilityQueryProcess(
  fork: (entryPath: string) => QueryUtilityProcess,
  entryPath = queryHostEntryPath('utility')
): QueryProcess {
  const host = fork(entryPath);
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
      const onError = (type: string, location: string, report: string): void =>
        listener(new Error(`SQLite query utility ${type} at ${location}: ${report}`));
      host.on('error', onError);
      return () => {
        host.off('error', onError);
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
