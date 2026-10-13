import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

export const options = {
  dbPath: '/owned/index.sqlite',
  embedding: { indexMode: 'text-only' },
  fileBindings: [],
  rootIds: [],
  scopes: [],
};
export const deadlines = { closeMs: 1000, exitMs: 1000, requestMs: 5000, startupMs: 60_000 };
// Existing utility ready payload, as validated by the real indexer transport.
export const info = {
  dbPath: options.dbPath,
  embedding: options.embedding,
  journalMode: 'wal',
  pid: 101,
  readerQueryOnly: 1,
  storeId: 'a'.repeat(64),
  vecVersion: 'v0.1.9',
  writerThreadId: 1,
};
export function child(holdReady = false, holdExit = false) {
  const process = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    postMessage: (message: object) => {
      if ('dbPath' in message) {
        if (!holdReady) {
          queueMicrotask(() => process.emit('message', { kind: 'ready', value: info }));
        }
        return;
      }
      if ('op' in message && message.op === 'close' && 'id' in message) {
        queueMicrotask(() => {
          process.emit('message', { id: message.id, kind: 'response', ok: true, value: true });
          if (!holdExit) {
            process.emit('exit', 0);
          }
        });
      }
    },
  });
  return process;
}
