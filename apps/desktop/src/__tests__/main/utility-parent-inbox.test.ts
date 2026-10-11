// @vitest-environment node
import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { receiveAgentHostParentMessage } from '../../agent-host-parent-control';
import { createUtilityParentInbox, loadUtilityStartup } from '../../utility-parent-inbox';

it('retains early close and rejects malformed controls with the existing decoder', () => {
  const parent = new EventEmitter();
  const inbox = createUtilityParentInbox(parent);
  const close = { data: { method: 'close' }, ports: [] };
  parent.emit('message', close);
  const cancel = vi.fn();
  const receive = vi.fn((input: unknown) =>
    receiveAgentHostParentMessage(input, undefined, cancel)
  );
  try {
    inbox.bind(receive);
    expect(receive).toHaveBeenCalledExactlyOnceWith(close);
    expect(cancel).toHaveBeenCalledOnce();
    expect(() => parent.emit('message', { data: { extra: true, method: 'close' } })).toThrow(
      TypeError
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(() => inbox.bind(receive)).toThrow('already bound');
  } finally {
    inbox.close();
  }
  expect(parent.listenerCount('message')).toBe(0);
});

it('retains the transferred lifetime port and observes parent loss before Core exists', async () => {
  const parent = new EventEmitter();
  const inbox = createUtilityParentInbox(parent);
  const channel = new MessageChannel();
  const cancelled = Promise.withResolvers<void>();
  const cancel = vi.fn(() => cancelled.resolve());
  parent.emit('message', { data: { event: 'lifetime' }, ports: [channel.port1] });
  try {
    inbox.bind((input) => receiveAgentHostParentMessage(input, undefined, cancel));
    channel.port2.close();
    await cancelled.promise;
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    inbox.close();
    channel.port1.close();
    channel.port2.close();
  }
});

it('cancels a held module load before its continuation can acquire the host', async () => {
  const loaded = Promise.withResolvers<() => void>();
  const controller = new AbortController();
  const acquired = vi.fn();
  const failure = new Error('Recorded parent close during kernel import');
  const starting = loadUtilityStartup(() => loaded.promise, controller.signal).then((start) =>
    start()
  );
  controller.abort(failure);
  await expect(starting).rejects.toBe(failure);
  loaded.resolve(acquired);
  await Promise.resolve();
  expect(acquired).not.toHaveBeenCalled();
});

it('does not start an import after cancellation was already received', async () => {
  const controller = new AbortController();
  const failure = new Error('Recorded early parent close');
  controller.abort(failure);
  const load = vi.fn(async () => undefined);
  await expect(loadUtilityStartup(load, controller.signal)).rejects.toBe(failure);
  expect(load).not.toHaveBeenCalled();
});
