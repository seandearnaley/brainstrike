import { fork } from 'node:child_process';
import path from 'node:path';

/**
 * Runs one fixture as a plain Node child and returns the one result it sends
 * over IPC (fixture-result.mjs).
 *
 * The child's @brainstrike/logging records reach stdout from pino's transport
 * worker thread, so a record logged before the result can land after it
 * (BST-2146). stdout and stderr are therefore never parsed; they are kept as
 * evidence for a failure.
 */
export function runFixtureProcess(
  fixture: string,
  args: readonly string[],
  signal?: AbortSignal
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // No inherited Vitest execArgv: the fixture runs under plain Node.
    const child = fork(fixture, args, { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const run = `${path.basename(fixture)} ${args[0] ?? ''}`;
    const results: unknown[] = [];
    let stdout = '';
    let stderr = '';
    let failure: unknown;
    const stop = () => {
      if (!child.kill('SIGTERM')) {
        failure = new Error(`Could not stop the owned fixture process ${run}.`);
      }
    };
    child.stdout?.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr?.on('data', (data) => {
      stderr += String(data);
    });
    child.on('message', (message) => {
      results.push(message);
    });
    child.on('error', (cause) => {
      failure = cause;
    });
    signal?.addEventListener('abort', stop, { once: true });
    // Node counts the IPC channel toward 'close', so every message the child
    // sent has been emitted by then.
    child.once('close', (code, signalCode) => {
      signal?.removeEventListener('abort', stop);
      const evidence = `stderr:\n${stderr}\nstdout:\n${stdout}`;
      if (failure !== undefined) {
        reject(failure);
      } else if (code !== 0) {
        reject(
          new Error(`Fixture ${run} exited ${code ?? signalCode}.\n${evidence}`, {
            cause: signal?.aborted ? signal.reason : undefined,
          })
        );
      } else if (signal?.aborted) {
        reject(signal.reason);
      } else if (results.length === 1) {
        resolve(results[0]);
      } else {
        reject(
          new Error(`Fixture ${run} sent ${results.length} results; expected one.\n${evidence}`)
        );
      }
    });
    if (signal?.aborted) {
      stop();
    }
  });
}
