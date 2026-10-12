import { createRequire } from 'node:module';
import { spawnNativeChild } from '@brainstrike/state-store/native-children';
import {
  GIT_MAX_BUFFER_BYTES,
  type GitCommandRun,
  type GitCommandRunner,
} from './assistant-server/git-service';
import {
  createWindowsCommandProcess,
  type WindowsCommandJob,
} from './assistant-server/windows-command-process';
import { resolveBundledSiblingPath } from './bundled-sibling-path';

// Retain failed native joins; a failed wait is not evidence that the Git tree exited.
const liveCommands = new Set<ReturnType<typeof createWindowsCommandProcess>>();

/** Git's Windows launcher has a child: overflow/abort must join their shared Job. */
export async function runWindowsGitCommand({
  args,
  binaryStdout,
  cwd,
  env,
  signal,
  timeoutMs,
}: Omit<Parameters<GitCommandRunner>[0], 'env'> & {
  readonly env: NodeJS.ProcessEnv;
}): Promise<GitCommandRun> {
  const wrapperPath = resolveBundledSiblingPath('Windows Git', 'windows-command-entry.js');
  const userEnvironment = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^NODE_CHANNEL_(?:FD|SERIALIZATION_MODE)$/iu.test(entry[0])
    )
  );
  const wrapperEnvironment = Object.fromEntries(
    Object.entries(userEnvironment).filter(
      ([name]) =>
        !/^(?:NODE_OPTIONS|NODE_PATH|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|ELECTRON_RUN_AS_NODE)$/iu.test(
          name
        )
    )
  );
  wrapperEnvironment['ELECTRON_RUN_AS_NODE'] = '1';
  const buffers = { stderr: [] as Buffer[], stdout: [] as Buffer[] };
  const sizes = { stderr: 0, stdout: 0 };
  let failureReason: GitCommandRun['failureReason'];
  let joined = false;
  const owner = createWindowsCommandProcess({
    command: {
      argv: [...args],
      cwd,
      env: userEnvironment,
      executable: 'git',
      windowsVerbatimArguments: false,
    },
    createJob: () => {
      const native = createRequire(wrapperPath)('@brainstrike/windows-job-native') as {
        createCommandJob(): WindowsCommandJob;
      };
      return native.createCommandJob();
    },
    onOutput: (stream, chunk) => {
      const remaining = GIT_MAX_BUFFER_BYTES - sizes[stream];
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        buffers[stream].push(captured);
        sizes[stream] += captured.byteLength;
      }
      if (chunk.byteLength > remaining) {
        failureReason ??= 'maxBuffer';
        // start() observes retirement failure; no result escapes an unjoined Job.
        void owner.retire().catch(() => {});
      }
    },
    onSettled: () => {
      joined = true;
      liveCommands.delete(owner);
    },
    spawnWrapper: () =>
      spawnNativeChild(process.execPath, [wrapperPath], {
        cwd,
        detached: false,
        env: wrapperEnvironment,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      }),
  });
  liveCommands.add(owner);
  const abort = (): void => {
    failureReason ??= 'timeout';
    void owner.retire().catch(() => {});
  };
  const timer = timeoutMs > 0 ? setTimeout(abort, timeoutMs) : undefined;
  timer?.unref();
  signal?.addEventListener('abort', abort, { once: true });
  let exitCode: number | null = null;
  let failureText = '';
  try {
    const completion = owner.start();
    if (signal?.aborted) {
      abort();
    }
    const outcome = await completion;
    exitCode = failureReason ? null : outcome.exitCode;
  } catch (error) {
    if (!joined) {
      throw error;
    }
    if (error instanceof Error) {
      failureText = error.message;
      if ('code' in error && error.code === 'ENOENT') {
        failureReason ??= 'notFound';
      }
    } else {
      failureText = String(error);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  const stdoutBuffer = Buffer.concat(buffers.stdout, sizes.stdout);
  const stderr = Buffer.concat(buffers.stderr, sizes.stderr).toString('utf8') || failureText;
  return {
    exitCode,
    ...(failureReason ? { failureReason } : {}),
    stderr,
    stdout: binaryStdout ? '' : stdoutBuffer.toString('utf8'),
    ...(binaryStdout ? { stdoutBuffer } : {}),
    timedOut: failureReason === 'timeout',
  };
}
