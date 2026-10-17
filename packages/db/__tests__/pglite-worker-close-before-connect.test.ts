/**
 * PGlite 0.5.10's worker client announces itself to the leader every 16 ms
 * until a leader connects. Closing the client before that (the direct
 * transport does, when its runtime was disposed mid-open: BST-1329) left the
 * loop posting to its closed BroadcastChannel, an unhandled InvalidStateError
 * on every such close. The repo's PGlite patch stops the loop once the client
 * is closed; this pins it against an upgrade that drops the patch.
 */
import { PGliteWorker } from '@electric-sql/pglite/worker';
import { afterEach, describe, expect, it } from 'vitest';

/** A worker that completes the client's handshake but never elects a leader. */
function createLeaderlessWorker(): Worker {
  const target = new EventTarget();
  const emit = (data: unknown) => {
    target.dispatchEvent(new MessageEvent('message', { data }));
  };
  const worker = Object.assign(target, {
    postMessage: (message: { readonly type?: string }) => {
      if (message.type === 'init') {
        queueMicrotask(() =>
          emit({ id: `close-before-connect-${crypto.randomUUID()}`, type: 'ready' })
        );
      }
    },
    terminate: () => undefined,
  });
  queueMicrotask(() => emit({ type: 'here' }));
  return worker as unknown as Worker;
}

describe('PGlite worker client closed before a leader connects', () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };

  afterEach(() => {
    process.off('unhandledRejection', onRejection);
    rejections.length = 0;
  });

  it('stops announcing itself instead of posting to its closed channel', async () => {
    process.on('unhandledRejection', onRejection);
    const client = await PGliteWorker.create(createLeaderlessWorker());
    expect(client.ready).toBe(false);

    await client.close();
    // Several of the loop's 16 ms ticks.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(rejections).toEqual([]);
  });
});
