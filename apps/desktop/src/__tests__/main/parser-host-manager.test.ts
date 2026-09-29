/**
 * Tests for `ParserHostManager` (Phase 4 Cycle 4.2).
 *
 * Mocks `electron.utilityProcess.fork` with a `FakeUtilityProcess` that the
 * test can drive by calling `.reply()` to simulate the parser host emitting
 * a response message. Mirrors the test pattern in db-host-manager.test.ts.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 4)
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeDesktopError } from '../../desktop-error-serialization';
import type { ParserHostParseRequest } from '../../parser-host-shared';

class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.exit());
    return true;
  });
  readonly postMessage = vi.fn((message: ParserHostParseRequest) => {
    this.messages.push(message);
  });
  readonly messages: ParserHostParseRequest[] = [];
  pid: number | undefined = 42;

  reply(response: unknown): void {
    this.emit('message', response);
  }

  exit(): void {
    this.emit('exit', 0);
  }
}

const forkMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  utilityProcess: {
    fork: forkMock,
  },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: (scope: string) => ({
      debug: vi.fn(),
      error: (...args: unknown[]) => {
        loggerErrorMock(...args);
        actual.createLogger(scope).error(...args);
      },
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: loggerWarnMock,
    }),
  };
});

function latestProcess(): FakeUtilityProcess {
  const value = forkMock.mock.results.at(-1)?.value;
  if (!(value instanceof FakeUtilityProcess)) {
    throw new Error('Expected fake utility process to be forked.');
  }
  return value;
}

const baseRequest: ParserHostParseRequest = {
  content: 'const x = 1',
  options: { errorRecovery: true, jsx: false, language: 'javascript' },
  requestId: 'req-1',
};

describe('ParserHostManager', () => {
  beforeEach(() => {
    vi.resetModules();
    forkMock.mockReset();
    forkMock.mockImplementation(() => new FakeUtilityProcess());
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid stop timeout %s',
    async (stopTimeoutMs) => {
      const { ParserHostManager } = await import('../../parser-host-manager');
      expect(() => new ParserHostManager({ entryPath: '/fake/entry.js', stopTimeoutMs })).toThrow(
        'parser host stopTimeoutMs must be positive and finite'
      );
      expect(forkMock).not.toHaveBeenCalled();
    }
  );

  it.each(['false', 'throw'] as const)(
    'preserves settled %s kill failure alongside a held-generation timeout',
    async (mode) => {
      const { ParserHostManager } = await import('../../parser-host-manager');
      const manager = new ParserHostManager({ entryPath: '/fake/entry.js', stopTimeoutMs: 20 });
      const first = manager.parse(baseRequest);
      const old = latestProcess();
      old.kill.mockImplementation(() => true);
      const olderStop = manager.stop().catch((error: unknown) => error);
      await first;
      const replacement = manager.parse(baseRequest);
      const current = latestProcess();
      const failure = { category: 'kill-failure', message: 'native kill threw' };
      current.kill.mockImplementation(() => {
        if (mode === 'throw') {
          throw failure;
        }
        return false;
      });
      try {
        const outcome = await manager.stop().catch((error: unknown) => error);
        expect(outcome).toBeInstanceOf(AggregateError);
        if (!(outcome instanceof AggregateError)) {
          throw new Error('Expected aggregate stop failure');
        }
        expect(outcome.errors).toHaveLength(2);
        if (mode === 'throw') {
          expect(outcome.errors[0]).toBe(failure);
        } else {
          expect(outcome.errors[0]).toEqual(new Error('parser host could not be stopped'));
        }
        expect(outcome.errors[1]).toEqual(new Error('parser host stop timeout after 20ms'));
        const serialized = serializeDesktopError(outcome);
        expect(serialized.errors).toHaveLength(2);
        expect(serialized.errors?.[0]?.message).toBe(
          mode === 'throw' ? 'native kill threw' : 'parser host could not be stopped'
        );
        expect(serialized.errors?.[1]?.message).toBe('parser host stop timeout after 20ms');
        expect(old.kill).toHaveBeenCalledTimes(1);
        expect(current.kill).toHaveBeenCalledTimes(1);
        expect(old.listenerCount('exit')).toBe(1);
        await expect(replacement).resolves.toMatchObject({
          error: 'parser host stopped',
          ok: false,
        });
      } finally {
        old.exit();
        current.kill.mockImplementation(() => {
          current.exit();
          return true;
        });
        await manager.stop();
        await olderStop;
      }
      expect(old.listenerCount('exit')).toBe(0);
      expect(current.listenerCount('exit')).toBe(0);
    }
  );

  it('joins process exit before stop resolves and removes its listeners', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
    const parse = manager.parse(baseRequest);
    const host = latestProcess();
    host.kill.mockImplementation(() => true);
    let stopped = false;
    const stopping = manager.stop().then(() => {
      stopped = true;
    });
    await expect(parse).resolves.toMatchObject({ error: 'parser host stopped', ok: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      expect(stopped).toBe(false);
    } finally {
      host.exit();
      await stopping;
    }
    expect(host.listenerCount('message')).toBe(0);
    expect(host.listenerCount('exit')).toBe(0);
  });

  it('ignores an old generation exit while a replacement reuses its request id', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
    const original = manager.parse(baseRequest);
    const old = latestProcess();
    old.kill.mockImplementation(() => true);
    const closing = manager.stop();
    await original;
    const replacement = manager.parse(baseRequest);
    const current = latestProcess();
    old.exit();
    current.reply({ ok: true, requestId: baseRequest.requestId, root: { sentinel: 'new' } });
    await expect(replacement).resolves.toMatchObject({ ok: true, root: { sentinel: 'new' } });
    await closing;
    await manager.stop();
  });

  it('ignores an old generation message while a replacement reuses its request id', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
    const original = manager.parse(baseRequest);
    const old = latestProcess();
    old.kill.mockImplementation(() => true);
    const closing = manager.stop();
    await original;
    const replacement = manager.parse(baseRequest);
    const current = latestProcess();
    old.reply({ ok: true, requestId: baseRequest.requestId, root: { sentinel: 'old' } });
    current.reply({ ok: true, requestId: baseRequest.requestId, root: { sentinel: 'new' } });
    old.exit();
    await expect(replacement).resolves.toMatchObject({ ok: true, root: { sentinel: 'new' } });
    await closing;
    await manager.stop();
  });

  it.each(['false', 'throw'] as const)(
    'retains a failed %s kill owner, blocks parsing and allows stop retry',
    async (mode) => {
      const { ParserHostManager } = await import('../../parser-host-manager');
      const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
      const pending = manager.parse(baseRequest);
      const host = latestProcess();
      const failure = new Error('kill failed');
      host.kill.mockImplementationOnce(() => {
        if (mode === 'throw') {
          throw failure;
        }
        return false;
      });
      const stop = manager.stop();
      if (mode === 'throw') {
        await expect(stop).rejects.toBe(failure);
      } else {
        await expect(stop).rejects.toThrow('parser host could not be stopped');
      }
      await expect(pending).resolves.toMatchObject({ error: 'parser host stopped', ok: false });
      const sent = host.postMessage.mock.calls.length;
      await expect(manager.parse(baseRequest)).resolves.toMatchObject({
        error: expect.stringContaining('retry stop before parsing'),
        ok: false,
      });
      expect(host.postMessage).toHaveBeenCalledTimes(sent);
      expect(forkMock).toHaveBeenCalledTimes(1);
      await manager.stop();
      expect(host.kill).toHaveBeenCalledTimes(2);
      expect(host.listenerCount('exit')).toBe(0);
      const retry = manager.parse(baseRequest);
      latestProcess().reply({ ok: true, requestId: baseRequest.requestId, root: {} });
      await expect(retry).resolves.toMatchObject({ ok: true });
      await manager.stop();
    }
  );

  it('cleans a failed-stop owner on natural exit and then permits lazy restart', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
    const pending = manager.parse(baseRequest);
    const host = latestProcess();
    host.kill.mockImplementation(() => false);
    await expect(manager.stop()).rejects.toThrow('could not be stopped');
    await pending;
    host.exit();
    await manager.stop();
    expect(host.kill).toHaveBeenCalledTimes(1);
    expect(host.listenerCount('message')).toBe(0);
    const replacement = manager.parse(baseRequest);
    latestProcess().reply({ ok: true, requestId: baseRequest.requestId, root: {} });
    await expect(replacement).resolves.toMatchObject({ ok: true });
    await manager.stop();
  });

  it('joins concurrent stops once and includes older closing generations in a later stop', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
    const pending = manager.parse(baseRequest);
    const old = latestProcess();
    old.kill.mockImplementation(() => true);
    old.pid = undefined; // Pre-spawn and post-exit share this value: it proves neither.
    const first = manager.stop();
    const second = manager.stop();
    await pending;
    const replacement = manager.parse(baseRequest);
    const current = latestProcess();
    current.kill.mockImplementation(() => true);
    let laterSettled = false;
    const later = manager.stop().then(() => {
      laterSettled = true;
    });
    await replacement;
    current.exit();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      expect(laterSettled).toBe(false);
      expect(old.kill).toHaveBeenCalledTimes(1);
      expect(current.kill).toHaveBeenCalledTimes(1);
    } finally {
      old.exit();
      await Promise.all([first, second, later]);
    }
    expect(old.listenerCount('exit')).toBe(0);
    expect(current.listenerCount('exit')).toBe(0);
  });

  it('handles synchronous exit inside kill and repeated stop without killing twice', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
    const pending = manager.parse(baseRequest);
    const host = latestProcess();
    host.kill.mockImplementation(() => {
      host.exit();
      return true;
    });
    await manager.stop();
    await expect(pending).resolves.toMatchObject({ error: 'parser host stopped', ok: false });
    await manager.stop();
    expect(host.kill).toHaveBeenCalledTimes(1);
    expect(host.listenerCount('message')).toBe(0);
    expect(host.listenerCount('exit')).toBe(0);
  });

  it('cleans partial message-listener acquisition after its immediate exit observer', async () => {
    const host = new FakeUtilityProcess();
    const realOn = host.on;
    vi.spyOn(host, 'on')
      .mockImplementationOnce((event, listener) => realOn.call(host, event, listener))
      .mockImplementationOnce((event, listener) => {
        realOn.call(host, event, listener);
        throw new Error('message listener attachment failed');
      });
    forkMock.mockReturnValueOnce(host);
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
    await expect(manager.parse(baseRequest)).resolves.toMatchObject({
      error: expect.stringContaining('message listener attachment failed'),
      ok: false,
    });
    await manager.stop();
    expect(host.kill).toHaveBeenCalledTimes(1);
    expect(host.listenerCount('message')).toBe(0);
    expect(host.listenerCount('exit')).toBe(0);
  });

  it('preserves partial-acquisition failure and reports failed cleanup through the logger', async () => {
    const host = new FakeUtilityProcess();
    const realOn = host.on;
    vi.spyOn(host, 'on')
      .mockImplementationOnce((event, listener) => realOn.call(host, event, listener))
      .mockImplementationOnce((event, listener) => {
        realOn.call(host, event, listener);
        throw new Error('message listener attachment failed');
      });
    host.kill.mockImplementationOnce(() => {
      throw new Error('cleanup kill failed');
    });
    forkMock.mockReturnValueOnce(host);
    const { addLogListener } = await import('@brainstrike/logging');
    const records: string[] = [];
    const remove = addLogListener((record) => {
      records.push(JSON.stringify(record));
    });
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
    try {
      await expect(manager.parse(baseRequest)).resolves.toMatchObject({
        error: expect.stringContaining('message listener attachment failed'),
        ok: false,
      });
      expect(
        records.some(
          (record) =>
            record.includes('Parser host acquisition cleanup failed') &&
            record.includes('cleanup kill failed')
        )
      ).toBe(true);
      await expect(manager.parse(baseRequest)).resolves.toMatchObject({
        error: expect.stringContaining('retry stop before parsing'),
        ok: false,
      });
    } finally {
      await manager.stop();
      remove();
    }
    expect(host.listenerCount('exit')).toBe(0);
  });

  it('forks the utility process on first parse and forwards the request', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });

    const parsePromise = manager.parse(baseRequest);
    const host = latestProcess();
    host.reply({ ok: true, requestId: 'req-1', root: { type: 'Program' } });

    const response = await parsePromise;
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]?.requestId).toBe('req-1');
    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-1');
  });

  it('reuses the same utility process across multiple parses', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });

    const p1 = manager.parse(baseRequest);
    const p2 = manager.parse({ ...baseRequest, requestId: 'req-2' });
    const host = latestProcess();
    host.reply({ ok: true, requestId: 'req-1', root: { type: 'Program' } });
    host.reply({ ok: true, requestId: 'req-2', root: { type: 'Program' } });

    await Promise.all([p1, p2]);
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it('correlates concurrent parses by requestId', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });

    const p1 = manager.parse({ ...baseRequest, requestId: 'a' });
    const p2 = manager.parse({ ...baseRequest, requestId: 'b' });
    const host = latestProcess();

    // Reply out of order — manager must correlate by requestId.
    host.reply({ ok: true, requestId: 'b', root: { type: 'Program' } });
    host.reply({ ok: true, requestId: 'a', root: { type: 'Program' } });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.requestId).toBe('a');
    expect(r2.requestId).toBe('b');
  });

  it('returns a failure response when the host exits before responding', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });

    const parsePromise = manager.parse(baseRequest);
    const host = latestProcess();
    host.exit();

    const response = await parsePromise;
    expect(response.ok).toBe(false);
    expect(response.requestId).toBe('req-1');
  });

  it('returns a failure response when the request times out', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js', requestTimeoutMs: 10 });

    const parsePromise = manager.parse(baseRequest);
    // Don't reply — let the timeout fire.

    const response = await parsePromise;
    expect(response.ok).toBe(false);
    expect(response.requestId).toBe('req-1');
    if (response.ok) {
      throw new Error('expected failure');
    }
    expect(response.error).toMatch(/timeout/i);
  });

  it('logs a late response at warn instead of dropping it silently', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js', requestTimeoutMs: 10 });

    const response = await manager.parse(baseRequest);
    expect(response.ok).toBe(false);
    loggerWarnMock.mockClear();

    // The host finished after the manager gave up: that completion must be
    // visible in logs, never vanish.
    latestProcess().reply({ ok: true, requestId: 'req-1', root: { type: 'Program' } });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requestId: 'req-1' })
    );
  });

  it('logs a malformed host message at warn as a shape summary, never the payload', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });

    const parsePromise = manager.parse(baseRequest);
    const host = latestProcess();
    // Parser traffic carries user source text and ASTs; the log must describe
    // the frame, not reproduce it.
    host.emit('message', { content: 'const secret = "user source text";', type: 'noise' });

    expect(loggerWarnMock).toHaveBeenCalledWith('Ignored malformed parser host message', {
      keyCount: 2,
      keys: ['content', 'type'],
      messageType: 'object',
      type: 'noise',
    });
    expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain('user source text');

    host.reply({ ok: true, requestId: 'req-1', root: { type: 'Program' } });
    await expect(parsePromise).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['success without root', { ok: true, requestId: 'req-1' }],
    ['success with array root', { ok: true, requestId: 'req-1', root: [] }],
    [
      'success with source text instead of a root',
      { ok: true, requestId: 'req-1', root: 'private user source text' },
    ],
    ['failure without error', { ok: false, requestId: 'req-1' }],
    ['failure with non-string error', { error: 42, ok: false, requestId: 'req-1' }],
  ])('ignores %s, logs only shape, and lets the known request time out', async (_name, frame) => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js', requestTimeoutMs: 10 });
    const parsePromise = manager.parse(baseRequest);

    latestProcess().reply(frame);

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Ignored malformed parser host message',
      expect.objectContaining({ messageType: 'object' })
    );
    expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain('private user source text');
    await expect(parsePromise).resolves.toEqual({
      error: 'parser host timeout after 10ms',
      ok: false,
      requestId: 'req-1',
    });
  });

  it('passes through a valid response and its opaque AST descendants unchanged', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
    const parsePromise = manager.parse(baseRequest);
    const root = {
      body: [{ deeplyNested: { content: 'user source text' } }],
      end: 10,
      start: 0,
      type: 'Program',
    };

    latestProcess().reply({ ok: true, requestId: 'req-1', root });

    const response = await parsePromise;
    expect(response).toEqual({ ok: true, requestId: 'req-1', root });
    if (response.ok) {
      expect(response.root).toBe(root);
    }
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('bounds the shape summary when the shape itself carries the payload', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });

    const parsePromise = manager.parse(baseRequest);
    const host = latestProcess();
    // A mis-serialized frame can put source text in `type` or in the keys
    // themselves, so counts are exact but the strings behind them are capped.
    const source = `const secret = "${'x'.repeat(400)}";`;
    host.emit('message', {
      type: source,
      [source]: 1,
      ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])),
    });

    const [, summary] = loggerWarnMock.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(summary['keyCount']).toBe(42);
    expect(summary['keys']).toHaveLength(20);
    for (const key of summary['keys'] as string[]) {
      expect(key.length).toBeLessThanOrEqual(65);
    }
    expect((summary['type'] as string).length).toBeLessThanOrEqual(65);
    expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain('x'.repeat(400));

    host.reply({ ok: true, requestId: 'req-1', root: { type: 'Program' } });
    await expect(parsePromise).resolves.toMatchObject({ ok: true });
  });

  it('summarizes a null, primitive and array frame by shape alone', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });

    const parsePromise = manager.parse(baseRequest);
    const host = latestProcess();
    host.emit('message', null);
    host.emit('message', 'const secret = "user source text";');
    // An array reports its length only: naming its indices would be as
    // unbounded as the payload itself.
    host.emit('message', ['user source text', 'more']);

    const summaries = loggerWarnMock.mock.calls.map((call) => call[1]);
    expect(summaries).toEqual(
      expect.arrayContaining([
        { messageType: 'null' },
        { messageType: 'string' },
        { length: 2, messageType: 'array' },
      ])
    );
    expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain('user source text');

    host.reply({ ok: true, requestId: 'req-1', root: { type: 'Program' } });
    await expect(parsePromise).resolves.toMatchObject({ ok: true });
  });

  it('logs a fork failure at error and still answers with ok: false', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
    const forkFailure = new Error('utilityProcess.fork failed: entry missing');
    forkMock.mockImplementationOnce(() => {
      throw forkFailure;
    });

    const response = await manager.parse(baseRequest);

    expect(response).toMatchObject({ ok: false });
    expect(loggerErrorMock).toHaveBeenCalledWith('Parser host request could not be sent', {
      error: forkFailure,
      requestId: 'req-1',
    });

    // A failed fork is never cached, so the next request forks again rather
    // than wedging the manager on a host that was never created.
    const retry = manager.parse(baseRequest);
    latestProcess().reply({ ok: true, requestId: 'req-1', root: { type: 'Program' } });
    await expect(retry).resolves.toMatchObject({ ok: true });
  });

  it('stop() kills the host and rejects pending requests', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });

    const parsePromise = manager.parse(baseRequest);
    const host = latestProcess();
    await manager.stop();

    expect(host.kill).toHaveBeenCalled();
    const response = await parsePromise;
    expect(response.ok).toBe(false);
  });
});
