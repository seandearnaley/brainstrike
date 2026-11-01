/**
 * The fence for shell commands (BST-2328). sandbox-runtime wraps one command
 * for the folder it may write, and the caller's own process owner spawns the
 * result, so a command keeps its streaming, output bounds, process-group
 * teardown and workspace lease.
 *
 * A wrap never installs process-global config: its filesystem rules ride on
 * the wrap itself, and the process-wide network list stays empty because
 * every domain grant is per command (BST-2327). So commands run beside each
 * other and beside run_python, never queued behind a ten-minute test run.
 * Each command gets its own temp folder as `TMPDIR`, removed with it: srt's
 * own `TMPDIR` (`/tmp/claude`) is writable only where that folder already
 * exists, and nothing here creates it.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { platform } from 'node:process';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { createLogger } from '@brainstrike/logging';
import {
  acquireFenceSession,
  FenceInvalidRequestError,
  newFenceCommandId,
} from './fence-executor.ts';
import { buildSandboxRuntimeConfig } from './fence-policy.ts';
import { withLinuxSeccompApplyPath } from './fence-readiness.ts';
import { isFenceSupported } from './fence-support.ts';

const logger = createLogger('FencedShell');

/** `value` as one POSIX sh word. */
const shWord = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export interface FencedShellRequest {
  /** The command, run by `shell -c` inside the sandbox. */
  readonly command: string;
  /** Absolute, canonical start directory, at or under `root`. */
  readonly cwd: string;
  /** The open folder the command may write. */
  readonly root: string;
  /** The user's shell; sandbox-runtime resolves it on PATH inside the sandbox. */
  readonly shell: string;
  readonly signal: AbortSignal;
}

export interface FencedShellCommand {
  /** The command's stderr with what sandbox-runtime recorded it refusing. */
  annotate(stderr: string): string;
  readonly args: readonly string[];
  /** Variables sandbox-runtime added; merge them over the command's own environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Spawn this with {@link args}, without a host shell. */
  readonly executable: string;
  /** Once, after the command's process group is gone; removes its temp folder. */
  release(): void;
}

export interface FencedShell {
  wrap(request: FencedShellRequest): Promise<FencedShellCommand>;
}

/**
 * The fenced shell for a host that has the fence, or undefined. The first wrap
 * runs the fence's readiness probe; a failed probe refuses that wrap with its
 * reason and the next wrap probes again. The session it holds lasts as long as
 * the process.
 */
export function createFencedShell(options: {
  readonly linuxSeccompApplyPath?: string;
}): FencedShell | undefined {
  if (!isFenceSupported()) {
    return;
  }
  const helperPath = options.linuxSeccompApplyPath;
  if (helperPath !== undefined && !(isAbsolute(helperPath) && !helperPath.includes('\0'))) {
    throw new FenceInvalidRequestError(
      'linuxSeccompApplyPath must be an absolute, NUL-free path to the trusted sandbox helper.'
    );
  }
  const linuxSeccompApplyPath = platform === 'linux' ? helperPath : undefined;
  let ready: Promise<void> | undefined;
  const session = (signal: AbortSignal): Promise<void> => {
    ready ??= acquireFenceSession(linuxSeccompApplyPath, signal).catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
  return {
    wrap: async (request) => {
      await session(request.signal);
      const temp = await realpath(await mkdtemp(join(tmpdir(), 'brainstrike-command-')));
      const removeTemp = (): void => {
        rm(temp, { force: true, recursive: true }).catch((error: unknown) => {
          logger.warn('A sandboxed command left its temp folder behind', { error, temp });
        });
      };
      try {
        // Validated on every wrap, as run_python does: srt would otherwise fall
        // back from a helper that disappeared to one it discovers itself.
        const config = await withLinuxSeccompApplyPath(
          await buildSandboxRuntimeConfig({ allowedDomains: [], allowWrite: [temp] }, request.root),
          linuxSeccompApplyPath
        );
        request.signal.throwIfAborted();
        const commandId = newFenceCommandId();
        // srt sets its own TMPDIR after anything a caller passes, so a POSIX sh
        // sets the command's and then becomes the person's shell: srt's
        // assembled-command idiom, with `commandText` naming what the model ran.
        const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
          `export TMPDIR=${shWord(temp)}; exec ${shWord(request.shell)} -c ${shWord(request.command)}`,
          '/bin/sh',
          config,
          request.signal,
          request.cwd,
          { commandId, commandText: request.command }
        );
        const [executable, ...args] = argv;
        if (executable === undefined) {
          SandboxManager.cleanupAfterCommand();
          throw new Error('sandbox-runtime returned an empty command vector.');
        }
        const added: Record<string, string> = {};
        for (const [name, value] of Object.entries(env)) {
          if (value !== undefined && process.env[name] !== value) {
            added[name] = value;
          }
        }
        let released = false;
        return {
          annotate: (stderr) => SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr),
          args,
          env: added,
          executable,
          release: () => {
            if (!released) {
              released = true;
              SandboxManager.cleanupAfterCommand();
              removeTemp();
            }
          },
        };
      } catch (error) {
        removeTemp();
        throw error;
      }
    },
  };
}
