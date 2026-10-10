// @vitest-environment node
import { ChildProcess, type Serializable } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { acquireWorkspaceMutationLease } from '@brainstrike/host-capabilities/native-tools';
import { expect, test, vi } from 'vitest';
import { createWindowsCommandProcess } from '../../assistant-server/windows-command-process';

const identity = { creationTime: '134050464000000001', pid: 31_001 };

function harness(onSettlement?: () => void) {
  const physical = Promise.withResolvers<void>();
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { configurable: true, value: identity.pid });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const events: string[] = [];
  const send = vi.fn<(message: Serializable, callback?: (error: Error | null) => void) => boolean>(
    () => {
      events.push('start');
      return true;
    }
  );
  // This fixture implements the message/callback overload used by the private gate.
  Object.defineProperty(child, 'send', { value: send });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  const job = {
    assign: vi.fn((): void => {
      events.push('assign');
    }),
    close: vi.fn(),
    terminateAndWait: vi.fn(() => physical.promise),
  };
  const onSettled = vi.fn(onSettlement);
  const onOutput = vi.fn();
  const spawnWrapper = vi.fn(() => child);
  const owner = createWindowsCommandProcess({
    command: {
      argv: ['/d', '/s', '/c', 'node task.cjs'],
      cwd: 'C:\\workspace',
      env: {},
      executable: 'cmd.exe',
      windowsVerbatimArguments: true,
    },
    createJob: () => job,
    onOutput,
    onSettled,
    spawnWrapper,
  });
  const close = (code = 1) => {
    child.emit('exit', code, null);
    child.emit('close', code, null);
  };
  const ready = () => child.emit('message', { identity, type: 'ready' });
  return {
    child,
    close,
    events,
    job,
    kill,
    onOutput,
    onSettled,
    owner,
    physical,
    ready,
    send,
    spawnWrapper,
  };
}

test('no wrapper starts until retained, and native identity assignment precedes the sole launch gate', async () => {
  const h = harness();
  expect(h.spawnWrapper).not.toHaveBeenCalled();
  const result = h.owner.start();
  expect(h.send).not.toHaveBeenCalled();
  h.ready();
  expect(h.job.assign).toHaveBeenCalledExactlyOnceWith(identity);
  expect(h.events).toEqual(['assign', 'start']);
  h.child.emit('message', { exitCode: 7, signal: null, type: 'completed' });
  h.physical.resolve();
  h.close();
  await expect(result).resolves.toEqual({ exitCode: 7, signal: null });
  expect(h.onSettled).toHaveBeenCalledTimes(1);
});

test('completion keeps the owner until both physical Job settlement and captured-pipe closure', async () => {
  const h = harness();
  const result = h.owner.start();
  h.ready();
  h.child.stdout?.emit('data', Buffer.from('captured stdout'));
  h.child.stderr?.emit('data', Buffer.from('captured stderr'));
  h.child.emit('message', { exitCode: 0, signal: null, type: 'completed' });
  h.close();
  await Promise.resolve();
  expect(h.onSettled).not.toHaveBeenCalled();
  expect(h.job.close).not.toHaveBeenCalled();
  h.physical.resolve();
  await expect(result).resolves.toEqual({ exitCode: 0, signal: null });
  expect(h.onOutput.mock.calls).toEqual([
    ['stdout', Buffer.from('captured stdout')],
    ['stderr', Buffer.from('captured stderr')],
  ]);
  expect(h.job.close).toHaveBeenCalledTimes(1);
});

test('cancellation before READY never opens the launch gate and joins the trusted unassigned wrapper', async () => {
  const h = harness();
  const result = h.owner.start();
  const retirement = h.owner.retire();
  h.ready();
  h.physical.resolve();
  await Promise.resolve();
  expect(h.onSettled).not.toHaveBeenCalled();
  expect(h.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(h.job.assign).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
  h.close(23);
  await retirement;
  await expect(result).resolves.toEqual({ exitCode: 23, signal: null });
});

test('forced completion reports the observed wrapper exit rather than the requested Job exit code', async () => {
  const h = harness();
  const result = h.owner.start();
  h.ready();
  const first = h.owner.retire();
  const second = h.owner.retire();
  h.close(23);
  h.physical.resolve();
  await Promise.all([first, second]);
  await expect(result).resolves.toEqual({ exitCode: 23, signal: null });
  expect(h.job.terminateAndWait).toHaveBeenCalledTimes(1);
  expect(h.onSettled).toHaveBeenCalledTimes(1);
});

test('wrapper death still joins its parent-owned Job and never invents a successful command receipt', async () => {
  const h = harness();
  const result = h.owner.start().catch((error: unknown) => error);
  h.ready();
  h.close(9);
  expect(h.job.terminateAndWait).toHaveBeenCalledTimes(1);
  expect(h.onSettled).not.toHaveBeenCalled();
  h.physical.resolve();
  await expect(result).resolves.toMatchObject({
    message: expect.stringMatching(/completion receipt/),
  });
  expect(h.onSettled).toHaveBeenCalledTimes(1);
});

test('denied physical retirement retains the entry and lease callback despite wrapper closure', async () => {
  const h = harness();
  const denied = new Error('TerminateJobObject denied');
  const result = h.owner.start().catch((error: unknown) => error);
  h.ready();
  const retirement = h.owner.retire().catch((error: unknown) => error);
  h.physical.reject(denied);
  h.close();
  expect(await retirement).toBe(denied);
  expect(await result).toBe(denied);
  expect(h.onSettled).not.toHaveBeenCalled();
  expect(h.job.close).not.toHaveBeenCalled();
  await expect(h.owner.retire()).rejects.toBe(denied);
  expect(h.job.terminateAndWait).toHaveBeenCalledTimes(1);
});

test('a different native identity or duplicate READY never starts user work twice', async () => {
  const h = harness();
  const result = h.owner.start().catch((error: unknown) => error);
  h.child.emit('message', { identity: { ...identity, pid: identity.pid + 1 }, type: 'ready' });
  expect(h.job.assign).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
  h.physical.resolve();
  h.close();
  await expect(result).resolves.toBeInstanceOf(Error);

  const duplicate = harness();
  const duplicateResult = duplicate.owner.start().catch((error: unknown) => error);
  duplicate.ready();
  duplicate.ready();
  duplicate.physical.resolve();
  duplicate.close();
  await expect(duplicateResult).resolves.toBeInstanceOf(Error);
  expect(duplicate.send).toHaveBeenCalledTimes(1);
});

test('a failed native assignment keeps the gate closed and joins the unassigned trusted child', async () => {
  const h = harness();
  const denied = new Error('AssignProcessToJobObject denied');
  h.job.assign.mockImplementation(() => {
    throw denied;
  });
  const result = h.owner.start().catch((error: unknown) => error);
  h.ready();
  expect(h.send).not.toHaveBeenCalled();
  expect(h.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  h.physical.resolve();
  h.close();
  expect(await result).toBe(denied);
  expect(h.onSettled).toHaveBeenCalledTimes(1);
});

test('disposal before start releases the unlaunched owner without spawning later', async () => {
  const h = harness();
  const retirement = h.owner.retire();
  const result = h.owner.start().catch((error: unknown) => error);
  expect(h.spawnWrapper).not.toHaveBeenCalled();
  await retirement;
  await expect(result).resolves.toBeInstanceOf(Error);
  expect(h.onSettled).toHaveBeenCalledTimes(1);
});

test('cancellation during identity assignment never sends START after the fence', async () => {
  const h = harness();
  h.job.assign.mockImplementation(() => {
    void h.owner.retire();
  });
  const result = h.owner.start();
  h.ready();
  expect(h.send).not.toHaveBeenCalled();
  h.physical.resolve();
  h.close(23);
  await expect(result).resolves.toEqual({ exitCode: 23, signal: null });
});

test('a failed START send remains visible and still joins the private Job', async () => {
  const h = harness();
  const failedSend = new Error('IPC send failed');
  h.send.mockImplementation((_message, callback) => {
    if (typeof callback !== 'function') {
      throw new Error('Expected the native send completion callback');
    }
    callback(failedSend);
    return false;
  });
  const result = h.owner.start().catch((error: unknown) => error);
  h.ready();
  expect(h.job.terminateAndWait).toHaveBeenCalledTimes(1);
  h.physical.resolve();
  h.close();
  expect(await result).toBe(failedSend);
  expect(h.onSettled).toHaveBeenCalledTimes(1);
});

test('denied Job cleanup leaves the existing workspace lease blocking an actual competing writer', async () => {
  const root = '/windows-command-owner-denied';
  const release = await acquireWorkspaceMutationLease(root, 'opaque');
  const h = harness(release);
  const denied = new Error('Native retirement denied');
  const result = h.owner.start().catch((error: unknown) => error);
  h.ready();
  const retirement = h.owner.retire().catch((error: unknown) => error);
  h.physical.reject(denied);
  h.close();
  expect(await retirement).toBe(denied);
  expect(await result).toBe(denied);
  const stopWaiting = new AbortController();
  let admitted = false;
  const writer = acquireWorkspaceMutationLease(root, 'files', stopWaiting.signal).then(
    (finish) => {
      admitted = true;
      finish();
    },
    (error: unknown) => error
  );
  try {
    const finishDisjoint = await acquireWorkspaceMutationLease('/unrelated-command-root', 'files');
    finishDisjoint();
    expect(admitted).toBe(false);
    expect(h.onSettled).not.toHaveBeenCalled();
    stopWaiting.abort(denied);
    expect(await writer).toBe(denied);
  } finally {
    // Release only the in-process test fixture; no OS process exists in this unit control.
    release();
  }
});

test('an asynchronous spawn failure with no PID joins the no-child close before releasing ownership', async () => {
  const h = harness();
  Object.defineProperty(h.child, 'pid', { value: undefined });
  h.kill.mockReturnValue(false);
  const spawnFailure = new Error('spawn ENOENT');
  const result = h.owner.start().catch((error: unknown) => error);
  h.child.emit('error', spawnFailure);
  h.physical.resolve();
  await Promise.resolve();
  expect(h.onSettled).not.toHaveBeenCalled();
  h.child.emit('close', -1, null);
  expect(await result).toBe(spawnFailure);
  expect(h.kill).not.toHaveBeenCalled();
  expect(h.onSettled).toHaveBeenCalledTimes(1);
});
