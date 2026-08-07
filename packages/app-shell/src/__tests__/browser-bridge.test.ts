import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_BRIDGE_REQUIRED_METHODS,
  type BrowserBridge,
  isBrowserBridgeAvailable,
  resolveBrowserBridge,
} from '../browser-pane/browser-bridge';

function fullBridge(): BrowserBridge {
  return {
    closeTab: () => Promise.resolve(),
    createTab: () => Promise.resolve('tab-1'),
    goBack: () => Promise.resolve(),
    goForward: () => Promise.resolve(),
    listTabs: () => Promise.resolve([]),
    navigate: () => Promise.resolve(),
    onTabsChanged: () => () => undefined,
    reload: () => Promise.resolve(),
    selectTab: () => Promise.resolve(),
    setBounds: () => Promise.resolve(),
    setOccluded: () => Promise.resolve(),
  };
}

afterEach(() => {
  Reflect.deleteProperty(window as Window & { browser?: unknown }, 'browser');
});

describe('resolveBrowserBridge', () => {
  it('returns null when window.browser is absent (web)', () => {
    expect(resolveBrowserBridge()).toBeNull();
    expect(isBrowserBridgeAvailable()).toBe(false);
  });

  it('resolves a fully-formed bridge', () => {
    (window as Window & { browser?: BrowserBridge }).browser = fullBridge();
    expect(resolveBrowserBridge()).not.toBeNull();
    expect(isBrowserBridgeAvailable()).toBe(true);
  });

  it('treats a bridge missing ANY required method as absent (no half-working surface)', () => {
    for (const method of BROWSER_BRIDGE_REQUIRED_METHODS) {
      const partial = fullBridge() as unknown as Record<string, unknown>;
      Reflect.deleteProperty(partial, method);
      (window as Window & { browser?: unknown }).browser = partial;
      expect(resolveBrowserBridge(), `missing ${method} must disable the bridge`).toBeNull();
    }
  });

  it('pins the exact required-method set', () => {
    expect([...BROWSER_BRIDGE_REQUIRED_METHODS].sort()).toEqual([
      'closeTab',
      'createTab',
      'goBack',
      'goForward',
      'listTabs',
      'navigate',
      'onTabsChanged',
      'reload',
      'selectTab',
      'setBounds',
      'setOccluded',
    ]);
  });
});
