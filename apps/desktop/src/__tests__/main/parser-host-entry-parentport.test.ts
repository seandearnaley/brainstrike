/**
 * Tests for the parser host's parentPort wiring (Phase 4 Cycle 4.1).
 *
 * These tests exercise the IPC plumbing layer: when the parser-host-entry
 * module is loaded inside a `utilityProcess` context, it registers a
 * message listener on `process.parentPort`, unwraps incoming envelopes,
 * dispatches to `handleParseRequest`, and posts responses back.
 *
 * Mirrors the test-time parentPort mocking pattern from
 * `db-host-entry.test.ts` — no real child process is spawned.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 4)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParserHostParseRequest, ParserHostParseResponse } from '../../parser-host-shared';

interface ParentPortMock {
  readonly on: (event: 'message', listener: (message: unknown) => void) => ParentPortMock;
  readonly postMessage: ReturnType<typeof vi.fn>;
}

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

function restoreParentPort(): void {
  if (originalParentPortDescriptor) {
    Object.defineProperty(process, 'parentPort', originalParentPortDescriptor);
    return;
  }
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

function installParentPortMock(): {
  readonly listeners: ((message: unknown) => void)[];
  readonly parentPort: ParentPortMock;
} {
  const listeners: ((message: unknown) => void)[] = [];
  const parentPort: ParentPortMock = {
    on: vi.fn((event: 'message', listener: (message: unknown) => void) => {
      if (event === 'message') {
        listeners.push(listener);
      }
      return parentPort;
    }),
    postMessage: vi.fn(),
  };
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: parentPort,
    writable: true,
  });
  return { listeners, parentPort };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const validRequest: ParserHostParseRequest = {
  content: 'const x = 1',
  options: {
    errorRecovery: true,
    jsx: false,
    language: 'javascript',
  },
  requestId: 'req-1',
};

describe('parser-host-entry parentPort wiring', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    restoreParentPort();
  });

  it('registers a message listener on parentPort at module load', async () => {
    const { listeners, parentPort } = installParentPortMock();

    await import('../../parser-host-entry');

    expect(parentPort.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(listeners).toHaveLength(1);
  });

  it('handles a raw parse request and posts back a success response', async () => {
    const { listeners, parentPort } = installParentPortMock();
    await import('../../parser-host-entry');

    listeners[0]?.(validRequest);
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledTimes(1);
    const sent = parentPort.postMessage.mock.calls[0]?.[0] as ParserHostParseResponse;
    expect(sent.requestId).toBe('req-1');
    expect(sent.ok).toBe(true);
  });

  it('unwraps Electron MessageEvent envelope (data: ...) before handling', async () => {
    const { listeners, parentPort } = installParentPortMock();
    await import('../../parser-host-entry');

    // Simulate the MessageEvent shape Electron sometimes delivers.
    listeners[0]?.({ data: validRequest });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledTimes(1);
    const sent = parentPort.postMessage.mock.calls[0]?.[0] as ParserHostParseResponse;
    expect(sent.ok).toBe(true);
  });

  it('returns a failure response when the payload is malformed', async () => {
    const { listeners, parentPort } = installParentPortMock();
    await import('../../parser-host-entry');

    listeners[0]?.({ requestId: 'bad', content: 123 /* not a string */ });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledTimes(1);
    const sent = parentPort.postMessage.mock.calls[0]?.[0] as ParserHostParseResponse;
    expect(sent.ok).toBe(false);
  });

  it('preserves requestId across malformed-payload failures when present', async () => {
    const { listeners, parentPort } = installParentPortMock();
    await import('../../parser-host-entry');

    listeners[0]?.({ requestId: 'preserved-id', content: 123 });
    await flushMicrotasks();

    const sent = parentPort.postMessage.mock.calls[0]?.[0] as ParserHostParseResponse;
    expect(sent.requestId).toBe('preserved-id');
  });
});
