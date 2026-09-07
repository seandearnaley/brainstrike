import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { killPosixProcessGroup } from '../run-official-mcp-client-conformance.mjs';

// POSIX process-group teardown for the official conformance driver. The
// end-to-end reap is covered by 'reaps a real POSIX process group and its
// descendant at the deadline' in run-official-mcp-client-conformance.test.mjs;
// this file pins the kernel boundary that test races against.
test('confirms teardown when the process group holds only a killed-but-unreaped member', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  process.kill(-child.pid, 'SIGKILL');
  // Spin rather than await: blocking the event loop keeps this process from
  // reaping the child, so the group settles into the exact teardown state the
  // driver races against — it still exists, but its only member is a zombie
  // the kernel will not route a group signal through, which POSIX-mode kill(2)
  // reports as EPERM rather than ESRCH.
  const spinDeadline = Date.now() + 5000;
  let groupState;
  while (Date.now() < spinDeadline) {
    try {
      process.kill(-child.pid, 0);
      groupState = 'alive';
    } catch (error) {
      groupState = error.code;
    }
    if (groupState === 'EPERM') {
      break;
    }
  }
  assert.equal(groupState, 'EPERM', 'precondition: the group must hold only an unreaped member');

  await killPosixProcessGroup(child.pid, 'SIGKILL');

  // Asserted before awaiting exit: returning is only sound once the group is
  // actually gone, so an implementation that reads EPERM as "already gone"
  // fails here instead of racing to a green.
  assert.throws(
    () => process.kill(-child.pid, 0),
    (error) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
  );
  await exited;
});
