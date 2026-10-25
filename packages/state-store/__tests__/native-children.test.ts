import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { terminateTree } from '../src/native-children.js';

// stdin is the sleeper's lifeline: it exits once this test process lets the pipe go or dies.
const SLEEPER = ['-e', "process.on('SIGTERM', () => {}); process.stdin.resume();"];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
});
/** A zombie has exited: only a reap is pending, which a container's init may never do. */
const isRunning = (pid: number): boolean => {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return state.status === 0 && !state.stdout.trim().startsWith('Z');
};

// ADR-0030: on Windows a kill stops only the program it names, so a launcher or shim would leave
// the real program running under it.
test("ending a launcher's tree ends the program it started", async () => {
  const launcher = spawn(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('node:child_process');
const program = spawn(process.execPath, ${JSON.stringify(SLEEPER)}, { stdio: 'ignore' });
process.stdout.write(program.pid + '\\n');
setInterval(() => {}, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  children.push(launcher);
  const [line] = await once(launcher.stdout, 'data');
  const program = Number(String(line).trim());
  const exited = once(launcher, 'exit');
  try {
    expect(isRunning(program)).toBe(true);
    await terminateTree(launcher.pid ?? 0);
    await exited;
    await expect.poll(() => isRunning(program)).toBe(false);
  } finally {
    if (isRunning(program)) {
      process.kill(program, 'SIGKILL');
    }
  }
});
