// @vitest-environment node

import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { CanonicalUtilityChannel } from '../canonical-utility-channel';
import {
  canonicalFault,
  decodeCanonicalFrame,
  MAX_CANONICAL_MESSAGE_BYTES,
} from '../canonical-utility-protocol';

describe('canonical utility ownership', () => {
  it('keeps a cancelled call owned until the remote operation physically settles', async () => {
    const frames: object[] = [];
    const channel = new CanonicalUtilityChannel((frame) => frames.push(frame));
    const controller = new AbortController();
    const pending = channel.call('owner', 'load-files', {}, Schema.String, controller.signal);
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    controller.abort(new DOMException('Stopped', 'AbortError'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(channel.pendingCount).toBe(1);
    expect(frames.at(-1)).toMatchObject({ id: 1, kind: 'cancel', owner: 'owner' });
    channel.receive({
      channel: 'canonical-ingestion-v1',
      id: 1,
      kind: 'result',
      ok: true,
      owner: 'owner',
      value: 'late',
    });
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(channel.pendingCount).toBe(0);
  });

  it('does not accept a response from another captured owner', async () => {
    const channel = new CanonicalUtilityChannel(() => {});
    const pending = channel.call('owner', 'load-files', {}, Schema.String);
    expect(() =>
      channel.receive({
        channel: 'canonical-ingestion-v1',
        id: 1,
        kind: 'result',
        ok: true,
        owner: 'foreign',
        value: 'late',
      })
    ).toThrow(/owner/);
    expect(channel.pendingCount).toBe(1);
    channel.receive({
      channel: 'canonical-ingestion-v1',
      id: 1,
      kind: 'result',
      ok: true,
      owner: 'owner',
      value: 'exact',
    });
    await expect(pending).resolves.toBe('exact');
  });

  it('rejects malformed and oversized envelopes', () => {
    expect(() =>
      decodeCanonicalFrame({
        channel: 'canonical-ingestion-v1',
        id: -1,
        kind: 'cancel',
        owner: 'owner',
      })
    ).toThrow();
    expect(() =>
      decodeCanonicalFrame({
        channel: 'canonical-ingestion-v1',
        extra: true,
        id: 1,
        kind: 'cancel',
        owner: 'owner',
      })
    ).toThrow();
    expect(() =>
      decodeCanonicalFrame({
        channel: 'canonical-ingestion-v1',
        event: 'error',
        kind: 'event',
        owner: 'owner',
        value: 'x'.repeat(MAX_CANONICAL_MESSAGE_BYTES),
      })
    ).toThrow(/bound/);
  });

  it('bounds pending calls and rolls back a synchronous failed send', async () => {
    const channel = new CanonicalUtilityChannel(() => {
      throw new Error('send failed');
    });
    await expect(channel.call('owner', 'load-files', {}, Schema.String)).rejects.toThrow(
      'send failed'
    );
    expect(channel.pendingCount).toBe(0);
    const full = new CanonicalUtilityChannel(() => {}, 1);
    const pending = full.call('owner', 'load-files', {}, Schema.String);
    await expect(full.call('owner', 'load-files', {}, Schema.String)).rejects.toThrow(/pending/);
    full.fail(new Error('exit joined'));
    await expect(pending).rejects.toThrow('exit joined');
  });
  it('preserves an independent remote AbortError despite concurrent caller cancellation', async () => {
    const channel = new CanonicalUtilityChannel(() => {});
    const controller = new AbortController();
    const pending = channel.call('owner', 'read-file', {}, Schema.String, controller.signal);
    controller.abort(new Error('Caller stopped'));
    channel.receive({
      channel: 'canonical-ingestion-v1',
      error: { message: 'Independent native IO failure', name: 'AbortError' },
      id: 1,
      kind: 'result',
      ok: false,
      owner: 'owner',
    });
    await expect(pending).rejects.toThrow('Independent native IO failure');
  });
  it('preserves primary and cleanup causes across the actual error envelope', async () => {
    const channel = new CanonicalUtilityChannel(() => {});
    const pending = channel.call('owner', 'close', null, Schema.Null);
    channel.receive({
      channel: 'canonical-ingestion-v1',
      error: canonicalFault(
        new AggregateError(
          [new Error('publication failed'), new Error('unsubscribe failed')],
          'retirement failed',
          { cause: new Error('original failure') }
        )
      ),
      id: 1,
      kind: 'result',
      ok: false,
      owner: 'owner',
    });
    const error: unknown = await pending.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error('Missing aggregate causes');
    }
    expect(
      error.errors.map((failure: unknown) => (failure instanceof Error ? failure.message : ''))
    ).toEqual(['publication failed', 'unsubscribe failed']);
    expect(error.cause).toMatchObject({ message: 'original failure' });
  });
});
