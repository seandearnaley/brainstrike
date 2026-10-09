// A real Root holder that starts one native command the way the desktop
// executor does (the shared host spawn, its own process group, stdin ignored,
// stdout/stderr piped back) and then waits. The command ignores SIGTERM, like a
// build in its grace window, so it outlives a crashed holder.
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { processStartTime, spawnNativeChild } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { startHost } from '../../src/runtime.js';

async function main(): Promise<void> {
  const root = makeThrowingDecoder(Schema.String)(process.argv[2]);
  const host = await startHost({ lifetime: 'persistent', root });
  const command = spawnNativeChild(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const pid = command.pid;
  const start = pid === undefined ? null : processStartTime(pid);
  if (pid === undefined || start === null) {
    throw new Error('The native command has no process identity');
  }
  process.stdout.write(
    `${JSON.stringify({ command: { pid, start }, host: { pid: host.record.pid, start: host.record.start } })}\n`
  );
  await host.closed;
}
main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exitCode = 1;
});
