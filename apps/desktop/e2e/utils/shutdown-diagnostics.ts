/**
 * BST-2239 proof only: what a hosted Windows shutdown diagnosis needs, written into the test's
 * output directory (the workflow uploads `test-results/` when a test fails). Enabled by
 * BRAINSTRIKE_E2E_SHUTDOWN_DIAGNOSTICS=1; nothing here changes what a test asserts.
 */

import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';

export const shutdownDiagnosticsEnabled =
  process.env['BRAINSTRIKE_E2E_SHUTDOWN_DIAGNOSTICS'] === '1';

function append(filePath: string, line: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`);
}

/** Every stdout/stderr line of Main (its agent host and utilities inherit it), stamped on receipt. */
export function recordProcessOutput(child: ChildProcess, filePath: string): void {
  append(filePath, `[harness] launched pid=${child.pid}`);
  const stream = (name: string) => {
    let partial = '';
    return (data: Buffer): void => {
      const lines = (partial + data.toString()).split(/\r?\n/u);
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) {
          append(filePath, `[${name}] ${line}`);
        }
      }
    };
  };
  child.stdout?.on('data', stream('stdout'));
  child.stderr?.on('data', stream('stderr'));
  child.once('exit', (code, signal) => {
    append(filePath, `[harness] main process exited code=${code} signal=${signal}`);
  });
}

export function markHarnessEvent(filePath: string, event: string): void {
  append(filePath, `[harness] ${event}`);
}

/** Main's own INFO log and its warn+ NDJSON backstop: `<userData>/logs` under E2E path isolation. */
export async function preserveAppLogs(userDataDir: string, destination: string): Promise<void> {
  try {
    await cp(path.join(userDataDir, 'logs'), destination, { recursive: true });
  } catch (error) {
    // Reported, never thrown: a copy failure must not replace the teardown failure it explains.
    console.error(`[BST-2239 harness] could not copy ${userDataDir}/logs:`, error);
  }
}
