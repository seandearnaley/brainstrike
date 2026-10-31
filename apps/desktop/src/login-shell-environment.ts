/**
 * The user's login-shell environment, resolved once the way VS Code does
 * (src/vs/platform/shell/node/shellEnv.ts, `getResolvedShellEnv`).
 *
 * launchd starts a Dock or Finder app with PATH `/usr/bin:/bin:/usr/sbin:/sbin`;
 * the PATH that finds git, node, pnpm and Homebrew tools is set by the user's
 * shell rc files. Main runs the shell as an interactive login shell, has it
 * print the environment it built, and applies that before it forks any child,
 * so the agent host and every command it runs inherit it.
 *
 * Unlike the reference, a shell that prints no environment is a failure the
 * caller reports, never an empty result. Like the reference, a shell that has
 * not printed within ten seconds is stopped with everything it started.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { EnvBootstrapLoginShell } from '@brainstrike/assistant-contract/env-bootstrap-bridge';
import { isDesktopEnvFileLoadingDisabled } from './desktop-env';

/** The reported outcome, plus the printed environment Main applies but never reports. */
export type LoginShellEnvironment =
  | (Extract<EnvBootstrapLoginShell, { status: 'resolved' }> & {
      readonly durationMs: number;
      readonly env: NodeJS.ProcessEnv;
    })
  | Exclude<EnvBootstrapLoginShell, { status: 'resolved' }>;

export interface ResolveLoginShellEnvironmentOptions {
  readonly argv: readonly string[];
  /** The launch environment; the shell starts from it. */
  readonly env: Readonly<NodeJS.ProcessEnv>;
  /** Electron's binary, run as Node to print the environment the shell built. */
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  /** How long the shell may take to print its environment. */
  readonly timeoutMs?: number;
}

/** VS Code's bound for resolving the shell environment. */
const LOGIN_SHELL_TIMEOUT_MS = 10_000;

/** Set while the shell runs so rc files can skip work (VS Code: VSCODE_RESOLVING_ENVIRONMENT). */
const RESOLVING_ENVIRONMENT = 'BRAINSTRIKE_RESOLVING_ENVIRONMENT';
const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE';

/** The shell's arguments; csh and tcsh accept `-i` but not `-l` with `-c`. */
function shellArguments(shell: string, command: string): string[] {
  const name = path.basename(shell);
  return name === 'csh' || name === 'tcsh' ? ['-ic', command] : ['-i', '-l', '-c', command];
}

function failed(shell: string, message: string): LoginShellEnvironment {
  return { message, shell, status: 'failed' };
}

export async function resolveLoginShellEnvironment(
  options: ResolveLoginShellEnvironmentOptions
): Promise<LoginShellEnvironment> {
  if (options.platform === 'win32') {
    return { reason: 'windows', status: 'skipped' };
  }
  // Test mode disables every ambient environment source, as it does the .env files.
  if (isDesktopEnvFileLoadingDisabled(options.argv, options.env)) {
    return { reason: 'test-mode', status: 'skipped' };
  }
  // Every shell exports SHLVL to what it starts; launchd does not. A terminal
  // launch already carries the user's shell environment (VS Code: VSCODE_CLI).
  if (options.env['SHLVL'] !== undefined) {
    return { reason: 'launched-from-shell', status: 'skipped' };
  }
  const shell = options.env['SHELL'] || userInfo().shell;
  if (!shell) {
    return failed('', 'SHELL is unset and the user account has no login shell.');
  }

  const mark = randomUUID().replaceAll('-', '');
  const printEnvironment = `'${options.execPath}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`;
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const printedEnvironment = new RegExp(`${mark}(\\{.*\\})${mark}`, 'u');
  return await new Promise<LoginShellEnvironment>((resolve) => {
    // Detached: the shell gets no controlling terminal, so a prompt reads EOF.
    const child = spawn(shell, shellArguments(shell, printEnvironment), {
      detached: true,
      env: { ...options.env, [RESOLVING_ENVIRONMENT]: '1', [RUN_AS_NODE]: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const settle = (result: LoginShellEnvironment): void => {
      deadline.removeEventListener('abort', stop);
      resolve(result);
    };
    // The shell leads its own process group, so stopping the group also stops
    // whatever its rc files started and left holding the output pipe.
    const stop = (): void => {
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        /* The group already exited. */
      }
      settle(
        failed(
          shell,
          `The login shell ${shell} did not print its environment within ${timeoutMs / 1000} s.`
        )
      );
    };
    if (child.pid !== undefined) {
      deadline.addEventListener('abort', stop, { once: true });
    }
    let output = '';
    child.stdout.setEncoding('utf8');
    // The closing mark ends the environment. A job the rc files started in the
    // background can hold the pipe open long after that, so the pipe's close
    // is not waited for, and the job is left running.
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      const printed = printedEnvironment.exec(output)?.[1];
      if (printed === undefined) {
        return;
      }
      child.stdout.destroy();
      child.unref();
      const env = JSON.parse(printed) as NodeJS.ProcessEnv;
      delete env[RESOLVING_ENVIRONMENT];
      // The child ran as Node; Main's own children must not.
      if (options.env[RUN_AS_NODE] === undefined) {
        delete env[RUN_AS_NODE];
      } else {
        env[RUN_AS_NODE] = options.env[RUN_AS_NODE];
      }
      settle({
        durationMs: Math.round(performance.now() - started),
        env,
        shell,
        status: 'resolved',
      });
    });
    child.on('error', (error) => {
      settle(failed(shell, `The login shell ${shell} could not start: ${error.message}`));
    });
    // A shell that ends before its closing mark failed; after it, this settles nothing.
    child.on('close', (code, signal) => {
      if (signal !== null) {
        settle(failed(shell, `The login shell ${shell} was stopped by ${signal}.`));
      } else if (code === 0) {
        settle(failed(shell, `The login shell ${shell} exited without printing its environment.`));
      } else {
        settle(
          failed(
            shell,
            `The login shell ${shell} exited with code ${code} before printing its environment.`
          )
        );
      }
    });
  });
}
