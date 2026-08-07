import { describe, expect, it, vi } from 'vitest';
import { type BrowserManagerLike, createBrowserIpcHandlers } from '../browser-ipc-handlers';

function fakeManager(): BrowserManagerLike & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    closeTab: (tabId) => calls.push(`close:${tabId}`),
    createTab: (url) => {
      calls.push(`create:${url ?? ''}`);
      return 'tab-1';
    },
    listTabs: () => {
      calls.push('list');
      return [
        {
          active: true,
          canGoBack: false,
          canGoForward: false,
          tabId: 'tab-1',
          title: 'T',
          url: 'https://x',
        },
      ];
    },
    navigate: (tabId, target) => calls.push(`nav:${tabId}:${target}`),
    selectTab: (tabId) => calls.push(`select:${tabId}`),
    setBounds: (rect) => calls.push(`bounds:${rect.x},${rect.y},${rect.width},${rect.height}`),
    setOccluded: (occluded) => calls.push(`occl:${occluded}`),
  };
}

describe('createBrowserIpcHandlers — validation at the boundary', () => {
  it('createTab accepts a string or undefined, rejects other types', () => {
    const manager = fakeManager();
    const handlers = createBrowserIpcHandlers(manager);
    expect(handlers.createTab('example.com')).toEqual({ ok: true, value: 'tab-1' });
    expect(handlers.createTab(undefined)).toEqual({ ok: true, value: 'tab-1' });
    expect(handlers.createTab(42)).toMatchObject({ ok: false });
    expect(manager.calls).toEqual(['create:example.com', 'create:']);
  });

  it('closeTab/selectTab require a non-empty string tabId', () => {
    const manager = fakeManager();
    const handlers = createBrowserIpcHandlers(manager);
    expect(handlers.closeTab('')).toMatchObject({ ok: false });
    expect(handlers.selectTab(7)).toMatchObject({ ok: false });
    expect(handlers.closeTab('tab-1')).toEqual({ ok: true, value: undefined });
    expect(manager.calls).toEqual(['close:tab-1']);
  });

  it('navigate requires a tabId and a non-empty target', () => {
    const manager = fakeManager();
    const handlers = createBrowserIpcHandlers(manager);
    expect(handlers.navigate('tab-1', '')).toMatchObject({ ok: false });
    expect(handlers.navigate('', 'back')).toMatchObject({ ok: false });
    expect(handlers.navigate('tab-1', 'back')).toEqual({ ok: true, value: undefined });
    expect(manager.calls).toEqual(['nav:tab-1:back']);
  });

  it('setBounds requires 4 finite non-negative numbers and rejects extra keys', () => {
    const manager = fakeManager();
    const handlers = createBrowserIpcHandlers(manager);
    expect(handlers.setBounds({ height: 10, width: 20, x: 1, y: 2 })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(handlers.setBounds({ height: -1, width: 20, x: 1, y: 2 })).toMatchObject({ ok: false });
    expect(handlers.setBounds({ height: 10, width: 20, x: 1, y: Number.NaN })).toMatchObject({
      ok: false,
    });
    expect(handlers.setBounds({ evil: 1, height: 10, width: 20, x: 1, y: 2 })).toMatchObject({
      ok: false,
    });
    expect(handlers.setBounds(null)).toMatchObject({ ok: false });
    expect(manager.calls).toEqual(['bounds:1,2,20,10']);
  });

  it('setOccluded requires a boolean', () => {
    const manager = fakeManager();
    const handlers = createBrowserIpcHandlers(manager);
    expect(handlers.setOccluded('yes')).toMatchObject({ ok: false });
    expect(handlers.setOccluded(true)).toEqual({ ok: true, value: undefined });
    expect(manager.calls).toEqual(['occl:true']);
  });

  it('listTabs returns the manager snapshot', () => {
    const handlers = createBrowserIpcHandlers(fakeManager());
    const result = handlers.listTabs();
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toHaveLength(1);
  });

  it('never throws for malformed input — always a structured result', () => {
    const handlers = createBrowserIpcHandlers(fakeManager());
    for (const call of [
      () => handlers.createTab({}),
      () => handlers.navigate(null, null),
      () => handlers.setBounds('nope'),
      () => handlers.setOccluded(undefined),
    ]) {
      expect(() => call()).not.toThrow();
      expect(call()).toMatchObject({ ok: false });
    }
    // Silence the expected warn logs from the rejections above.
    vi.restoreAllMocks();
  });
});
