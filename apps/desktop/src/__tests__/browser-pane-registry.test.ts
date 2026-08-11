import { describe, expect, it } from 'vitest';
import type { BrowserPaneHost } from '../browser/browser-pane-host';
import {
  clearActiveBrowserPaneHost,
  getActiveBrowserPaneHost,
  setActiveBrowserPaneHost,
} from '../browser/browser-pane-registry';

function host(): BrowserPaneHost {
  return { dispose: () => undefined } as unknown as BrowserPaneHost;
}

describe('browser-pane-registry', () => {
  it('closing a NEWER window falls back to the older still-live host', () => {
    const w1 = host();
    const w2 = host();
    setActiveBrowserPaneHost(w1);
    setActiveBrowserPaneHost(w2);
    expect(getActiveBrowserPaneHost()).toBe(w2);

    clearActiveBrowserPaneHost(w2);
    expect(getActiveBrowserPaneHost()).toBe(w1); // not null — w1's pane is live

    clearActiveBrowserPaneHost(w1);
    expect(getActiveBrowserPaneHost()).toBeNull();
  });

  it('re-registering an existing host moves it to the top without duplication', () => {
    const w1 = host();
    const w2 = host();
    setActiveBrowserPaneHost(w1);
    setActiveBrowserPaneHost(w2);
    setActiveBrowserPaneHost(w1);
    expect(getActiveBrowserPaneHost()).toBe(w1);
    clearActiveBrowserPaneHost(w1);
    expect(getActiveBrowserPaneHost()).toBe(w2);
    clearActiveBrowserPaneHost(w2);
    expect(getActiveBrowserPaneHost()).toBeNull();
  });
});
