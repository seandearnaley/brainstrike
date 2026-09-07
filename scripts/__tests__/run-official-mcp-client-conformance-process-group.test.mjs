import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { killPosixProcessGroup } from '../run-official-mcp-client-conformance.mjs';

// POSIX process-group teardown for the official conformance driver. The
// end-to-end reap is covered by 'reaps a real POSIX process group and its
// descendant at the deadline' in run-official-mcp-client-conformance.test.mjs;
// this file pins the kernel boundary that test races against.
//
// How a group signal reads while the group's only member is a killed-but-
// unreaped zombie is kernel-specific, and both answers were measured directly:
// Darwin's killpg1() drops zombies from its signalable count and reports EPERM,
// while Linux keeps them in the PIDTYPE_PGID hash until release_task() and
// simply succeeds. The portable invariant is narrower than either answer — the
// group is NOT gone — and that is what must reach the confirmation loop instead
// of ending teardown.
const UNREAPED_GROUP_STATE = process.platform === 'darwin' ? 'EPERM' : 'alive';

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
  // reaping the child, so the group stays in the exact teardown state the
  // driver races against. Darwin needs a few iterations for the signal to
  // land; Linux reports the state on the first probe.
  const spinDeadline = Date.now() + 1000;
  let groupState;
  while (Date.now() < spinDeadline) {
    try {
      process.kill(-child.pid, 0);
      groupState = 'alive';
    } catch (error) {
      groupState = error?.code ?? 'unknown';
    }
    if (groupState === UNREAPED_GROUP_STATE) {
      break;
    }
  }
  assert.equal(
    groupState,
    UNREAPED_GROUP_STATE,
    'precondition: the group must still exist with its only member unreaped'
  );

  await killPosixProcessGroup(child.pid, 'SIGKILL');

  // Asserted before awaiting exit: returning is only sound once the group is
  // actually gone, so an implementation that ends teardown on anything short
  // of ESRCH fails here instead of racing to a green.
  assert.throws(
    () => process.kill(-child.pid, 0),
    (error) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
  );
  await exited;
});
