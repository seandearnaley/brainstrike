// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { acquireIndexerHost, closeIndexerRuntime, getReadyIndexerHost } from '../indexer-runtime';
import { child, deadlines, options } from './fixtures/indexer-supervisor-process';

const physical = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({
  app: { isReady: () => true },
  utilityProcess: { fork: physical.fork },
}));
vi.mock('../bundled-sibling-path', () => ({
  resolveBundledSiblingPath: () => '/owned/indexer-host-entry.js',
}));
function hooks() {
  const failed = vi.fn(async (_error: unknown) => {});
  const ready = vi.fn(async () => {});
  return {
    failed,
    lost: vi.fn(async (_error: unknown) => ({ failed, ready })),
    ready,
    released: vi.fn(),
    retire: vi.fn(async () => {}),
  };
}
afterEach(async () => {
  await closeIndexerRuntime(async () => {});
  physical.fork.mockReset();
});

it('fences actual utility loss synchronously and joins borrowed cleanup before one replacement', async () => {
  const first = child();
  const second = child();
  physical.fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
  const borrowed = Promise.withResolvers<void>();
  const lifecycle = hooks();
  lifecycle.retire.mockImplementation(() => borrowed.promise);
  const original = await acquireIndexerHost(options, deadlines, lifecycle);
  first.emit('exit', 1);
  expect(lifecycle.lost).toHaveBeenCalledOnce();
  expect(() => getReadyIndexerHost()).toThrow();
  await vi.waitFor(() => expect(lifecycle.retire).toHaveBeenCalledOnce());
  expect(physical.fork).toHaveBeenCalledOnce();
  borrowed.resolve();
  await vi.waitFor(() => expect(lifecycle.ready).toHaveBeenCalledOnce());
  expect(getReadyIndexerHost()).not.toBe(original);
  expect(lifecycle.released).toHaveBeenCalledOnce();
  second.emit('exit', 1);
  await vi.waitFor(() => expect(lifecycle.failed).toHaveBeenCalledOnce());
  await expect(acquireIndexerHost(options, deadlines, lifecycle)).rejects.toBeDefined();
  expect(physical.fork).toHaveBeenCalledTimes(2);
});

it('rejects held initial acquisition before release joins it and never recursively stops', async () => {
  const first = child(true);
  physical.fork.mockReturnValueOnce(first).mockReturnValueOnce(child());
  const lifecycle = hooks();
  const admitted = acquireIndexerHost(options, deadlines, lifecycle);
  const outcome = admitted.catch((error: unknown) => error);
  lifecycle.retire.mockImplementation(async () => {
    expect(await outcome).toBeInstanceOf(Error);
  });
  await vi.waitFor(() => expect(physical.fork).toHaveBeenCalledOnce());
  first.emit('exit', 1);
  await expect(admitted).rejects.toMatchObject({ code: 'indexer-exited' });
  await vi.waitFor(() => expect(lifecycle.ready).toHaveBeenCalledOnce());
  expect(lifecycle.retire).toHaveBeenCalledOnce();
  expect(physical.fork).toHaveBeenCalledTimes(2);
  await closeIndexerRuntime(async () => {});
  expect(lifecycle.retire).toHaveBeenCalledTimes(2);
});

it('retains a failed reader retirement and closes the same physical process on explicit retry', async () => {
  physical.fork.mockReturnValueOnce(child());
  const lifecycle = hooks();
  const manager = await acquireIndexerHost(options, deadlines, lifecycle);
  const failure = new Error('Owned reader has not exited');
  await expect(
    closeIndexerRuntime(async () => {
      throw failure;
    })
  ).rejects.toBe(failure);
  expect(() => getReadyIndexerHost()).toThrow();
  await expect(acquireIndexerHost(options, deadlines, lifecycle)).rejects.toBe(failure);
  expect(manager.exited).toBe(false);
  expect(physical.fork).toHaveBeenCalledOnce();
  await closeIndexerRuntime(async () => {});
  expect(manager.exited).toBe(true);
});

it('a close acknowledgement retains the process until physical exit and never rearms passive demand', async () => {
  const process = child(false, true);
  physical.fork.mockReturnValueOnce(process);
  const lifecycle = hooks();
  const manager = await acquireIndexerHost(options, deadlines, lifecycle);
  let settled = false;
  const stopped = closeIndexerRuntime(async () => {}).then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(lifecycle.retire).toHaveBeenCalledOnce());
  await expect(acquireIndexerHost(options, deadlines, lifecycle)).rejects.toBeDefined();
  expect(settled).toBe(false);
  expect(manager.exited).toBe(false);
  expect(physical.fork).toHaveBeenCalledOnce();
  process.emit('exit', 0);
  await stopped;
  expect(manager.exited).toBe(true);
  expect(lifecycle.lost).not.toHaveBeenCalled();
});
