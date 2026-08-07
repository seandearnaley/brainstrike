import { describe, expect, it, vi } from 'vitest';
import { createDebuggerCdpSession, type DebuggerLike } from '../debugger-cdp-session';

/** Fake Electron `webContents.debugger`. */
function fakeDebugger(overrides?: Partial<DebuggerLike>): DebuggerLike & {
  messageHandlers: Array<(event: unknown, method: string, params: unknown) => void>;
  attached: boolean;
} {
  const messageHandlers: Array<(event: unknown, method: string, params: unknown) => void> = [];
  let attached = false;
  return {
    attach: vi.fn((_version?: string) => {
      attached = true;
    }),
    get attached() {
      return attached;
    },
    detach: vi.fn(() => {
      attached = false;
    }),
    isAttached: () => attached,
    messageHandlers,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        messageHandlers.push(handler as (e: unknown, m: string, p: unknown) => void);
      }
    }),
    sendCommand: vi.fn(() => Promise.resolve({ ok: true })),
    ...overrides,
  } as DebuggerLike & {
    messageHandlers: Array<(event: unknown, method: string, params: unknown) => void>;
    attached: boolean;
  };
}

describe('createDebuggerCdpSession', () => {
  it('attaches with the CDP protocol version only when not already attached', () => {
    const dbg = fakeDebugger();
    createDebuggerCdpSession(dbg);
    expect(dbg.attach).toHaveBeenCalledWith('1.3');

    (dbg.attach as ReturnType<typeof vi.fn>).mockClear();
    createDebuggerCdpSession(dbg); // already attached now
    expect(dbg.attach).not.toHaveBeenCalled();
  });

  it('send delegates to sendCommand', async () => {
    const dbg = fakeDebugger();
    const session = createDebuggerCdpSession(dbg);
    await session.send('Page.navigate', { url: 'https://x' });
    expect(dbg.sendCommand).toHaveBeenCalledWith('Page.navigate', { url: 'https://x' });
  });

  it('on(event) fires only for matching CDP message methods', () => {
    const dbg = fakeDebugger();
    const session = createDebuggerCdpSession(dbg);
    const handler = vi.fn();
    session.on('Network.responseReceived', handler);

    for (const emit of dbg.messageHandlers) {
      emit({}, 'Network.requestWillBeSent', { a: 1 });
      emit({}, 'Network.responseReceived', { b: 2 });
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ b: 2 });
  });

  it('detach only detaches when attached', () => {
    const dbg = fakeDebugger();
    const session = createDebuggerCdpSession(dbg);
    session.detach();
    expect(dbg.detach).toHaveBeenCalledTimes(1);
    session.detach(); // already detached
    expect(dbg.detach).toHaveBeenCalledTimes(1);
  });
});
