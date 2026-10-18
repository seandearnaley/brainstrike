import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { closeDesktopRenderers } from '../close-desktop-renderers';

function rendererWindow() {
  const events = new EventEmitter();
  const window = Object.assign(events, {
    close: vi.fn(),
    destroy: vi.fn(() => {
      window.isDestroyed.mockReturnValue(true);
      window.emit('closed');
    }),
    isDestroyed: vi.fn(() => false),
    webContents: new EventEmitter(),
  });
  return window;
}

describe('closeDesktopRenderers', () => {
  it('joins ordinary close before dependencies stop and leaves hidden host listeners alive', async () => {
    const visible = rendererWindow();
    const hidden = rendererWindow();
    const stopDependencies = vi.fn();
    const draining = closeDesktopRenderers([visible, hidden], (window) => window === hidden).then(
      stopDependencies
    );
    await Promise.resolve();
    expect(visible.close).toHaveBeenCalledOnce();
    expect(hidden.close).not.toHaveBeenCalled();
    expect(stopDependencies).not.toHaveBeenCalled();
    visible.emit('closed');
    await draining;
    expect(stopDependencies).toHaveBeenCalledOnce();
    expect(visible.listenerCount('closed')).toBe(0);
  });

  it('subscribes before a synchronous close and ignores windows already destroyed', async () => {
    const visible = rendererWindow();
    visible.close.mockImplementation(() => {
      visible.emit('closed');
    });
    const destroyed = rendererWindow();
    destroyed.isDestroyed.mockReturnValue(true);
    await closeDesktopRenderers([visible, destroyed], () => false);
    expect(visible.close).toHaveBeenCalledOnce();
    expect(destroyed.close).not.toHaveBeenCalled();
  });

  it('accepts a window destroyed during close without reporting a false shutdown failure', async () => {
    const visible = rendererWindow();
    visible.close.mockImplementation(() => {
      visible.isDestroyed.mockReturnValue(true);
      throw new Error('Object has been destroyed');
    });
    await expect(closeDesktopRenderers([visible], () => false)).resolves.toBeUndefined();
    expect(visible.listenerCount('closed')).toBe(0);
  });

  it('destroys a window whose renderer exits mid-close, after that event reached its other listeners', async () => {
    // BST-2135: a signal to Main's process group kills the renderer while it unloads.
    const visible = rendererWindow();
    const readsWindow = vi.fn(() => expect(visible.isDestroyed()).toBe(false));
    const draining = closeDesktopRenderers([visible], () => false);
    visible.webContents.on('render-process-gone', readsWindow);
    expect(visible.close).toHaveBeenCalledOnce();
    expect(visible.destroy).not.toHaveBeenCalled();
    visible.webContents.emit('render-process-gone');
    expect(visible.destroy).not.toHaveBeenCalled();
    await draining;
    expect(readsWindow).toHaveBeenCalledOnce();
    expect(visible.destroy).toHaveBeenCalledOnce();
    expect(visible.webContents.listenerCount('render-process-gone')).toBe(1);
  });

  it('never destroys a live renderer that is still closing', async () => {
    const visible = rendererWindow();
    const draining = closeDesktopRenderers([visible], () => false);
    visible.emit('closed');
    await draining;
    expect(visible.destroy).not.toHaveBeenCalled();
    expect(visible.webContents.listenerCount('render-process-gone')).toBe(0);
  });

  it('attempts every renderer, joins their closes and reports a failed close', async () => {
    const failed = rendererWindow();
    const visible = rendererWindow();
    failed.close.mockImplementation(() => {
      throw new Error('native close refused');
    });
    const draining = closeDesktopRenderers([failed, visible], () => false);
    const assertion = expect(draining).rejects.toThrow('Desktop renderer shutdown failed');
    expect(visible.close).toHaveBeenCalledOnce();
    visible.emit('closed');
    await assertion;
    expect(failed.listenerCount('closed')).toBe(0);
  });
});
