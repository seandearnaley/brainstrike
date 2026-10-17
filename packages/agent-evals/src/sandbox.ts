/**
 * One eval's disposable directories: the workspace (a copy of the task's
 * `repo/` with a baseline commit), a fresh host data root and a home that
 * keeps the owner's global hooks, personas and git config out of the run.
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export interface EvalSandbox {
  readonly dataRoot: string;
  /** The process environment every eval child (host, git, verifier) starts from. */
  readonly env: Readonly<Record<string, string>>;
  readonly home: string;
  readonly remove: () => Promise<void>;
  readonly root: string;
  readonly workspace: string;
}

export interface CommandResult {
  readonly code: number | null;
  readonly output: string;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

/** Runs a command to completion; a non-zero exit is a result, never a throw. */
export function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        killSignal: 'SIGTERM',
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs,
        windowsHide: true,
      },
      (cause, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        if (!cause) {
          resolve({ code: 0, output, signal: null, stderr, stdout, timedOut: false });
          return;
        }
        const failure = cause as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        if (typeof failure.code === 'string') {
          // ENOENT and friends: the command could not start at all.
          reject(cause);
          return;
        }
        resolve({
          code: failure.code ?? null,
          output,
          signal: failure.signal ?? null,
          stderr,
          stdout,
          timedOut: Boolean(failure.killed) && failure.signal === 'SIGTERM',
        });
      }
    );
  });
}

const GIT_IDENTITY = [
  '-c',
  'user.name=agent-evals',
  '-c',
  'user.email=agent-evals@localhost',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
];

async function git(workspace: string, env: Readonly<Record<string, string>>, args: string[]) {
  const result = await runCommand('git', [...GIT_IDENTITY, ...args], {
    cwd: workspace,
    env,
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in the eval workspace: ${result.output.trim()}`);
  }
}

/** A fresh sandbox holding a copy of `repoDir`, committed as the baseline. */
export async function createEvalSandbox(repoDir: string): Promise<EvalSandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-agent-eval-')));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  const home = join(root, 'home');
  const remove = () => rm(root, { force: true, recursive: true });
  try {
    await cp(repoDir, workspace, { recursive: true });
    await mkdir(dataRoot);
    await mkdir(home);
    const systemRoot = process.env['SystemRoot'];
    const env: Record<string, string> = {
      ['GIT_CONFIG_NOSYSTEM']: '1',
      ['HOME']: home,
      ['LC_ALL']: 'C',
      // This process's Node runs every `node` child: the host and the verifier.
      ['PATH']: [dirname(process.execPath), process.env['PATH'] ?? ''].join(delimiter),
      ['TZ']: 'UTC',
      ...(systemRoot ? { ['SystemRoot']: systemRoot } : {}),
    };
    await git(workspace, env, ['init', '--quiet', '--initial-branch=main']);
    await git(workspace, env, ['add', '--all']);
    await git(workspace, env, ['commit', '--quiet', '--message', 'baseline']);
    return { dataRoot, env, home, remove, root, workspace };
  } catch (cause) {
    await remove();
    throw cause;
  }
}

/** The hidden verifier's own directory inside the finished workspace. */
export const VERIFY_DIR = '.verify';

/** Copies the hidden verifier in, after the run, then runs `command` in the workspace. */
export async function runVerifier(options: {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly verifyDir: string | undefined;
  readonly workspace: string;
}): Promise<{ readonly exitCode: number | null; readonly output: string }> {
  if (options.verifyDir) {
    await cp(options.verifyDir, join(options.workspace, VERIFY_DIR), {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
  }
  const [command, ...args] = options.command;
  if (!command) {
    throw new Error('The verify command is empty');
  }
  const result = await runCommand(command, args, {
    cwd: options.workspace,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  return {
    exitCode: result.code,
    output: result.timedOut
      ? `timed out after ${options.timeoutMs} ms\n${result.output}`
      : result.output,
  };
}
