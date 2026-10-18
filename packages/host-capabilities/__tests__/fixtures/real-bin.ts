/**
 * Budgets and cleanup shared by the suites that run the production bin, and
 * the hosts it starts, as real processes.
 */
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { expect } from 'vitest';

/** The production executable, `bin/brainstrike.mjs`. */
export const bin = fileURLToPath(new URL('../../bin/brainstrike.mjs', import.meta.url));

/**
 * One budget for each real-process step: a bin invocation, and each wait on a
 * process it started (an exit, a Root release). 15 s, or 30 s on the nightly
 * (`TEST_TIMEOUT_MULTIPLIER=2`). Unthrottled, `host start` takes about 1 s; on
 * the hosted 2-vCPU coverage runner, about 10 s (BST-2157), at the 10 s
 * `execFile` guards these suites used and far past `expect.poll`'s 1 s default.
 *
 * A test budget, not a product bound. The product's own deadlines (the
 * launcher's 10 s startup, the starter's 10 s readiness) still run inside the
 * bin, and a missed one fails the command with its own error.
 */
export const REAL_PROCESS_TIMEOUT_MS = getAdjustedTimeout('integration');

/** `expect.poll` options for a wait on a real process. */
export const REAL_PROCESS_WAIT = { timeout: REAL_PROCESS_TIMEOUT_MS } as const;

export interface ProcessResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ProcessOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments?: boolean;
}

/**
 * Runs `executable` to its exit. An exit code resolves, nonzero included. A
 * process that outlives the budget, ends on a signal or cannot start rejects
 * with that reason and the output it wrote. `execFile`'s own "Command failed"
 * message gives neither, which left the hosted failures unexplained.
 */
export function runProcess(
  executable: string,
  args: readonly string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd ?? tmpdir(),
        encoding: 'utf8',
        env: options.env,
        timeout: REAL_PROCESS_TIMEOUT_MS,
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
      },
      (cause, stdout, stderr) => {
        if (!cause) {
          resolve({ code: 0, stderr, stdout });
          return;
        }
        // A bin `run` handles SIGTERM by stopping its run and exits 1, so a
        // process killed at the budget can report an exit code: `killed` decides.
        if (typeof cause.code === 'number' && !cause.killed) {
          resolve({ code: cause.code, stderr, stdout });
          return;
        }
        const ending = cause.signal === null ? `exited ${cause.code}` : `ended on ${cause.signal}`;
        const reason =
          typeof cause.code === 'string'
            ? `failed: ${cause.code}`
            : cause.killed
              ? `did not exit within ${REAL_PROCESS_TIMEOUT_MS} ms and was sent SIGTERM; it ${ending}`
              : ending;
        reject(
          new Error(
            `${[executable, ...args].join(' ')} ${reason}\nstdout: ${stdout}\nstderr: ${stderr}`,
            { cause }
          )
        );
      }
    );
  });
}

/** Runs the production bin against `dataRoot` under exactly `env`. */
export function runBin(
  dataRoot: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<ProcessResult> {
  return runProcess(process.execPath, [bin, '--data-root', dataRoot, ...args], { env });
}

const NO_HOST = 'No host is running for this root\n';

/**
 * After a test, stops the host that still owns `dataRoot` through the CLI and
 * waits for its process to exit. The CLI waits for a starting owner to publish
 * its record. A test that failed mid-start can also leave an owner that closes
 * by itself (a starter that dies before its host is ready cancels that host):
 * the stop then finds no host once the owner releases, which is not a cleanup
 * failure. An owner gone without releasing the Root fails here under its pid.
 * A stop reply is not an exit (a cold Windows host spent 1.4 s saving Node's
 * compile cache after releasing the Root), so physical retirement is awaited.
 */
export async function retireRootOwner(
  dataRoot: string,
  stop: () => Promise<ProcessResult>
): Promise<void> {
  const owner = RootLock.inspect(dataRoot)?.owner;
  // A test that opens the StateStore itself leaves this process as the last,
  // released owner: there is no host to retire.
  if (!owner || (owner.released && owner.pid === process.pid)) {
    return;
  }
  if (!owner.released) {
    const stopped = await stop();
    if (!(stopped.code === 1 && stopped.stderr === NO_HOST)) {
      expect(stopped, JSON.stringify(stopped)).toMatchObject({ code: 0, stderr: '' });
    }
    expect(
      RootLock.inspect(dataRoot)?.owner.released,
      `Root owner pid ${owner.pid} after host stop ${JSON.stringify(stopped)}`
    ).toBe(true);
  }
  await expect
    .poll(() => processStartTime(owner.pid), {
      ...REAL_PROCESS_WAIT,
      message: `Root owner pid ${owner.pid} did not exit`,
    })
    .toBeNull();
}
