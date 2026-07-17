import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('useAppActive', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when document is focused and visible', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.hasFocus = () => true;
    const { isAppActive } = await import('../use-app-active');
    expect(isAppActive()).toBe(true);
  });

  it('returns false when document is hidden', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.hasFocus = () => false;
    const { isAppActive } = await import('../use-app-active');
    expect(isAppActive()).toBe(false);
  });

  it('returns false when document is visible but not focused', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.hasFocus = () => false;
    const { isAppActive } = await import('../use-app-active');
    expect(isAppActive()).toBe(false);
  });

  it('updates when visibilitychange fires', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.hasFocus = () => true;
    const { isAppActive } = await import('../use-app-active');
    expect(isAppActive()).toBe(true);

    // Simulate going hidden
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.hasFocus = () => false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(isAppActive()).toBe(false);
  });

  it('updates when window blur/focus fires', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.hasFocus = () => true;
    const { isAppActive } = await import('../use-app-active');
    expect(isAppActive()).toBe(true);

    // Simulate blur
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.hasFocus = () => false;
    window.dispatchEvent(new Event('blur'));
    expect(isAppActive()).toBe(false);

    // Simulate focus
    document.hasFocus = () => true;
    window.dispatchEvent(new Event('focus'));
    expect(isAppActive()).toBe(true);
  });
});
