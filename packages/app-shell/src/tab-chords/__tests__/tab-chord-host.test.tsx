import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/ui', () => ({
  isMacPlatform: () => true,
  useToast: () => ({ toast: vi.fn() }),
}));

import { TabChordHost } from '../tab-chord-host';
import { registerTabChordStrip } from '../tab-chord-registry';

/** `Reflect` because the window typings already declare a narrower `desktopLifecycle`. */
function setLifecycleBridge(bridge: unknown): void {
  Reflect.set(window, 'desktopLifecycle', bridge);
}

function registerWorkspace(close: (id: string) => Promise<void>): () => void {
  return registerTabChordStrip('workspace', {
    activate: () => Promise.resolve(),
    close,
    getActiveId: () => 'a.ts',
    getPanel: () => null,
    getTabs: () => [{ id: 'a.ts', label: 'a.ts' }],
    hasClosedTabs: () => false,
    reopenClosed: () => Promise.resolve({ ok: true }),
  });
}

function pressCommandW(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'w',
    metaKey: true,
  });
  document.body.dispatchEvent(event);
  return event;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'desktopLifecycle');
});

describe('TabChordHost', () => {
  it('claims ⌘W when the desktop window-lifecycle bridge is present', () => {
    setLifecycleBridge({
      isTestMode: false,
      noteReloadIntent: () => Promise.resolve(),
    });
    const close = vi.fn(() => Promise.resolve());
    const release = registerWorkspace(close);
    try {
      render(<TabChordHost />);
      expect(pressCommandW().defaultPrevented).toBe(true);
      expect(close).toHaveBeenCalledWith('a.ts');
    } finally {
      release();
    }
  });

  it('leaves ⌘W to the browser on web', () => {
    const close = vi.fn(() => Promise.resolve());
    const release = registerWorkspace(close);
    try {
      render(<TabChordHost />);
      expect(pressCommandW().defaultPrevented).toBe(false);
      expect(close).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
