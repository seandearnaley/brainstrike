/** Trusted launch gate shared by the desktop bundle and the Node hook entry. */
import { spawn } from 'node:child_process';
import { decodeWindowsCommandStart } from './windows-command-process.js';

export function runWindowsCommandWrapper(
  getCurrentProcessIdentity: () => { readonly creationTime: string; readonly pid: number }
): void {
  if (!process.send || process.platform !== 'win32') {
    throw new Error('Windows command wrapper requires its private parent channel on Windows.');
  }

  let started = false;
  let completed = false;
  function send(message: unknown): void {
    if (!process.send) {
      throw new Error('Windows command wrapper lost its parent channel.');
    }
    process.send(message, (error: Error | null) => {
      if (error) {
        process.exit(1);
      }
    });
  }

  process.on('disconnect', () => process.exit(1));
  process.on('message', (input: unknown) => {
    try {
      if (started) {
        throw new Error('Duplicate Windows command launch.');
      }
      const { command } = decodeWindowsCommandStart(input);
      started = true;
      const child = spawn(command.executable, command.argv, {
        cwd: command.cwd,
        detached: false,
        env: command.env,
        stdio: [command.stdin === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
        windowsHide: true,
        windowsVerbatimArguments: command.windowsVerbatimArguments,
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        completed = true;
        send({ code: error.code ?? 'spawn-failed', type: 'failed' });
      });
      child.once('exit', (exitCode, signal) => {
        if (completed) {
          return;
        }
        completed = true;
        send({ exitCode, signal, type: 'completed' });
      });
      // Hook stdin remains best-effort. Report write failures over the private
      // channel, without turning them into command output or a process failure.
      child.stdin?.on('error', (error: Error) => {
        send({ message: error.message, type: 'stdin-error' });
      });
      if (command.stdin !== undefined) {
        try {
          child.stdin?.end(command.stdin);
        } catch (error) {
          send({
            message: error instanceof Error ? error.message : String(error),
            type: 'stdin-error',
          });
        }
      }
    } catch {
      send({ code: 'invalid-launch', type: 'failed' });
    }
  });
  send({ identity: getCurrentProcessIdentity(), type: 'ready' });
}
