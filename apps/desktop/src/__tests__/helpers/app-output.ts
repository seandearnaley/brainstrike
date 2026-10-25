import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';

/** Main's one record of a quit that exited 0 with a failed step (ADR-0026 R4). */
const SHUTDOWN_FAILURES_RECORD = '"msg":"Graceful shutdown completed with cleanup failures"';

export interface AppOutput {
  /**
   * Joins every recorded app's output, then requires that no quit recorded a failed shutdown
   * step. Exit code 0 alone does not prove it: a failed step is logged and the next one runs.
   */
  expectCleanShutdown(): Promise<void>;
  /**
   * Appends a launched app's stdout and stderr to the evidence log as they arrive: a proof that
   * outlives its test timeout never reaches its finally, and the app's own output is what names
   * a startup failure.
   */
  record(app: ChildProcess): void;
}

export function createAppOutput(path: string): AppOutput {
  const closed: Promise<unknown>[] = [];
  return {
    expectCleanShutdown: async () => {
      if (closed.length === 0) {
        return;
      }
      // `close` follows the exit once the app's pipes have delivered their last chunk.
      await Promise.all(closed);
      // Matched, not parsed: stdout and stderr chunks share the file and may interleave.
      const failures = (await readFile(path, 'utf8'))
        .split('\n')
        .filter((line) => line.includes(SHUTDOWN_FAILURES_RECORD));
      expect(failures, 'The app quit with failed shutdown steps').toEqual([]);
    },
    record: (app) => {
      closed.push(once(app, 'close'));
      app.stdout?.on('data', (data: Buffer) => appendFileSync(path, data));
      app.stderr?.on('data', (data: Buffer) => appendFileSync(path, data));
    },
  };
}
