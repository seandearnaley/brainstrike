// @vitest-environment node
import type { HostClient } from '@brainstrike/agent-host/browser';
import { expect, test, vi } from 'vitest';
import { WindowHostConnection } from '../renderer/window-host-connection';

function client(name: string): HostClient & { exit(): void; readonly name: string } {
  const closed = Promise.withResolvers<void>();
  return {
    close: vi.fn(async () => closed.resolve()),
    closed: closed.promise,
    exit: () => closed.resolve(),
    name,
  } as unknown as HostClient & { exit(): void; readonly name: string };
}

test('a closed connection reattaches once, announcing restarting, then connects the replacement', async () => {
  const first = client('first');
  const second = client('second');
  const connect = vi.fn<() => Promise<HostClient>>();
  connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const attached = vi.fn();
  const connection = new WindowHostConnection(connect, attached);
  const states: string[] = [];
  connection.subscribe(() => states.push(connection.getSnapshot().status));

  expect(await connection.client()).toBe(first);
  first.exit();
  await expect.poll(() => connection.getSnapshot().status).toBe('connected');
  expect(await connection.client()).toBe(second);
  expect(states).toEqual(['connected', 'restarting', 'connected']);
  expect(attached.mock.calls.map(([attachedClient]) => attachedClient)).toEqual([first, second]);
  expect(connect).toHaveBeenCalledTimes(2);
});

test('a failed reattach waits for an explicit retry, and never retries on its own', async () => {
  const first = client('first');
  const third = client('third');
  const connect = vi.fn<() => Promise<HostClient>>();
  connect
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new Error('No agent host could start'))
    .mockResolvedValueOnce(third);
  const connection = new WindowHostConnection(connect, () => undefined);
  await connection.client();
  first.exit();
  await expect
    .poll(() => connection.getSnapshot())
    .toEqual({
      error: 'No agent host could start',
      status: 'failed',
    });
  // Nothing tries again until asked.
  await new Promise((resolve) => setImmediate(resolve));
  expect(connect).toHaveBeenCalledTimes(2);
  connection.retry();
  await expect.poll(() => connection.getSnapshot().status).toBe('connected');
  expect(await connection.client()).toBe(third);
});

test('closing the window never reattaches', async () => {
  const first = client('first');
  const connect = vi.fn<() => Promise<HostClient>>().mockResolvedValueOnce(first);
  const connection = new WindowHostConnection(connect, () => undefined);
  await connection.client();
  await connection.close();
  expect(connection.getSnapshot().status).toBe('connected');
  expect(connect).toHaveBeenCalledOnce();
  await expect(connection.client()).rejects.toThrow('closing');
});
