import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { QueryRequest } from './protocol.js';

export interface QueryProcess {
  readonly kill: () => void;
  readonly onError: (listener: (error: Error) => void) => () => void;
  readonly onExit: (listener: () => void) => () => void;
  readonly onMessage: (listener: (message: unknown) => void) => () => void;
  readonly pid?: number | undefined;
  readonly postMessage: (message: QueryRequest) => void;
}

export interface SpawnQueryProcessOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly executable?: string;
}

export function queryHostEntryPath(transport: 'node' | 'utility'): string {
  return fileURLToPath(
    new URL(transport === 'node' ? './query-host.js' : './utility-query-host.js', import.meta.url)
  );
}

/** Explicit runtime choice; the child rejects unsupported SQLite builds. */
export function spawnQueryProcess(options: SpawnQueryProcessOptions = {}): QueryProcess {
  const child = fork(queryHostEntryPath('node'), [], {
    env: { ...process.env, ...options.environment },
    execPath: options.executable ?? process.execPath,
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  return {
    kill: (): void => {
      if (!(exited || child.kill('SIGKILL'))) {
        throw new Error('Could not kill the owned SQLite query process.');
      }
    },
    onError: (listener: (error: Error) => void): (() => void) => {
      child.on('error', listener);
      return () => {
        child.off('error', listener);
      };
    },
    onExit: (listener: () => void): (() => void) => {
      if (exited) {
        queueMicrotask(listener);
      } else {
        child.on('exit', listener);
      }
      return () => {
        child.off('exit', listener);
      };
    },
    onMessage: (listener: (message: unknown) => void): (() => void) => {
      child.on('message', listener);
      return () => {
        child.off('message', listener);
      };
    },
    get pid(): number | undefined {
      return child.pid;
    },
    postMessage: (message: QueryRequest): void => {
      if (!child.connected) {
        throw new Error('SQLite query process IPC is disconnected.');
      }
      child.send(message, (error) => {
        if (error && !exited) {
          child.emit('error', error);
        }
      });
    },
  };
}
