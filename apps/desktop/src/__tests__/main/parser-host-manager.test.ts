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
import type { ParserHostParseRequest, ParserHostParseResponse } from '../../parser-host-shared';

class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn((message: ParserHostParseRequest) => {
    this.messages.push(message);
  });
  readonly messages: ParserHostParseRequest[] = [];
  pid: number | undefined = 42;

  reply(response: ParserHostParseResponse): void {
    this.emit('message', response);
  }

  exit(): void {
    this.emit('exit', 0);
  }
}

const forkMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  utilityProcess: {
    fork: forkMock,
  },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
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
  });
  afterEach(() => {
    vi.resetModules();
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

  it('logs a malformed host message at warn instead of ignoring it', async () => {
    const { ParserHostManager } = await import('../../parser-host-manager');
    const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });

    const parsePromise = manager.parse(baseRequest);
    const host = latestProcess();
    host.emit('message', { unexpected: true });

    expect(loggerWarnMock).toHaveBeenCalledWith(expect.any(String), expect.anything());
    host.reply({ ok: true, requestId: 'req-1', root: { type: 'Program' } });
    await expect(parsePromise).resolves.toMatchObject({ ok: true });
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
