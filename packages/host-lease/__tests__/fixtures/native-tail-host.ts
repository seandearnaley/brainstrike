// A real Root holder that starts one native command the way the desktop
// executor does (the shared host spawn, its own process group, stdout/stderr
// piped back) and then waits. The command ignores SIGTERM, like a build in its
// grace window, so only its OS mechanism can end it with a crashed holder or
// keep the Root refused.
//
// fd 3 is the test's lifeline: a pipe whose other end only the test process
// holds. This host closes when it ends, and the command reads it as its stdin
// and exits at its end, so neither outlives the test process however that
// process ends. The command's copy keeps the test's end open after this host
// dies, so a killed host still leaves the command running.
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { processStartTime, spawnNativeChild } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { startHost } from '../../src/runtime.js';

const LIFELINE = 3;
const lifeline = new Socket({ fd: LIFELINE, readable: true, writable: false }).resume();
const lifelineEnded = new Promise<void>((resolve) => {
  lifeline.once('close', () => resolve());
});

async function main(): Promise<void> {
  const root = makeThrowingDecoder(Schema.String)(process.argv[2]);
  if (process.platform === 'win32') {
    // ADR-0017: Windows has no inheritable Root lock. Like the agent host's process
    // entry, this host joins a kill-on-close Job before it starts any native process.
    const windowsJob: typeof import('@brainstrike/windows-job-native') = createRequire(
      import.meta.url
    )('@brainstrike/windows-job-native');
    windowsJob.initialize();
  }
  const host = await startHost({ lifetime: 'persistent', root });
  try {
    const command = spawnNativeChild(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); process.stdin.resume();"],
      { cwd: root, detached: true, stdio: [LIFELINE, 'pipe', 'pipe'] }
    );
    const pid = command.pid;
    const start = pid === undefined ? null : processStartTime(pid);
    if (pid === undefined || start === null) {
      throw new Error('The native command has no process identity');
    }
    process.stdout.write(
      `${JSON.stringify({ command: { pid, start }, host: { pid: host.record.pid, start: host.record.start } })}\n`
    );
    await Promise.race([host.closed, lifelineEnded]);
  } finally {
    await host.close();
  }
}
main()
  .catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
    process.exitCode = 1;
  })
  .finally(() => lifeline.destroy());
