import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { waitForWindowClosed } from '../window-lifecycle-utils';

function createMockWindow(destroyed = false): BrowserWindow {
  const emitter = new EventEmitter();
  return {
    // expose emitter for test control
    _emit: (event: string) => emitter.emit(event),
    isDestroyed: vi.fn(() => destroyed),
    on: vi.fn((event: string, listener: () => void) => {
      emitter.on(event, listener);
      return emitter;
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      emitter.removeListener(event, listener);
      return emitter;
    }),
  } as unknown as BrowserWindow & { _emit: (event: string) => boolean };
}

describe('waitForWindowClosed', () => {
  it('resolves immediately when window is already destroyed', async () => {
    const window = createMockWindow(true);
    await waitForWindowClosed(window, 5000);
    expect(window.isDestroyed).toHaveBeenCalled();
  });

  it('resolves when window emits closed event', async () => {
    const window = createMockWindow();
    const promise = waitForWindowClosed(window, 5000);

    // Emit closed event
    (window as unknown as { _emit: (e: string) => void })._emit('closed');

    await promise;
    expect(window.removeListener).toHaveBeenCalledWith('closed', expect.any(Function));
  });

  it('resolves after timeout when window does not close', async () => {
    const window = createMockWindow();
    const start = Date.now();
    await waitForWindowClosed(window, 50);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(window.removeListener).toHaveBeenCalledWith('closed', expect.any(Function));
  });

  it('handles double-settle gracefully (closed after timeout)', async () => {
    const window = createMockWindow();
    const promise = waitForWindowClosed(window, 10);

    // Wait for timeout
    await promise;

    // Emit closed after timeout — should not throw
    (window as unknown as { _emit: (e: string) => void })._emit('closed');
  });

  it('handles removeListener throwing (window destroyed between settle)', async () => {
    const window = createMockWindow();
    vi.mocked(window.removeListener).mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });

    const promise = waitForWindowClosed(window, 50);

    // Emit closed — removeListener will throw but should be caught
    (window as unknown as { _emit: (e: string) => void })._emit('closed');

    await promise; // should not reject
  });

  it('handles window.on throwing (destroyed between check and registration)', async () => {
    const window = createMockWindow();
    vi.mocked(window.on).mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });

    // Should resolve immediately via the catch in the on() try block
    await waitForWindowClosed(window, 5000);
  });
});
