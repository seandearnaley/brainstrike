import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { joinWindowClosed } from '../window-lifecycle-utils';

function createMockWindow(destroyed = false): BrowserWindow {
  const emitter = new EventEmitter();
  return {
    // expose emitter for test control
    _emit: (event: string) => emitter.emit(event),
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((event: string, listener: () => void) => {
      emitter.once(event, listener);
      return emitter;
    }),
  } as unknown as BrowserWindow & { _emit: (event: string) => boolean };
}

describe('joinWindowClosed', () => {
  it('resolves at once for a window already destroyed', async () => {
    const window = createMockWindow(true);
    await joinWindowClosed(window);
    expect(window.once).not.toHaveBeenCalled();
  });

  it('resolves on closed and never on a clock (ADR-0026 R4)', async () => {
    vi.useFakeTimers();
    try {
      const window = createMockWindow();
      let joined = false;
      const joining = joinWindowClosed(window).then(() => {
        joined = true;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(joined).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      (window as unknown as { _emit: (e: string) => void })._emit('closed');
      await joining;
      expect(joined).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
