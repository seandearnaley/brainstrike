import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { closeDesktopRenderers } from '../close-desktop-renderers';

function rendererWindow() {
  const events = new EventEmitter();
  return Object.assign(events, {
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
  });
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
