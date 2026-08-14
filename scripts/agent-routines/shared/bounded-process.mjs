import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createSpawnInvocation } from '../../spawn-command.mjs';

const TAIL_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;

function signalProcessTree(child, signal) {
  if (process.platform === 'win32') {
    child.kill(signal);
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }
}

function appendTail(current, chunk) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= TAIL_BYTES ? combined : combined.subarray(combined.length - TAIL_BYTES);
}

export function runBoundedProcess({ command, cwd = process.cwd(), env = {}, timeoutMs }) {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error('invalid bounded process request');
  }
  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const invocation = createSpawnInvocation(command[0], command.slice(1));
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        detached: process.platform !== 'win32',
        env: { ...process.env, ...env },
        shell: invocation.shell,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        durationMs: Math.round(performance.now() - started),
        exitCode: null,
        outcome: 'spawn-error',
        signal: null,
        stderrTail: String(error),
        stdoutTail: '',
      });
      return;
    }
    child.stdout.on('data', (chunk) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendTail(stderr, chunk);
    });
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), TERMINATION_GRACE_MS);
    }, timeoutMs);
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        durationMs: Math.round(performance.now() - started),
        exitCode: value.exitCode,
        outcome: value.outcome,
        signal: value.signal,
        stderrTail: stderr.toString('utf8'),
        stdoutTail: stdout.toString('utf8'),
      });
    };
    child.once('error', (error) => {
      stderr = appendTail(stderr, String(error));
      finish({ exitCode: null, outcome: 'spawn-error', signal: null });
    });
    child.once('close', (code, signal) => {
      finish({
        exitCode: code,
        outcome: timedOut ? 'timed-out' : signal ? 'signalled' : code === 0 ? 'passed' : 'failed',
        signal,
      });
    });
  });
}
