import { describe, expect, it } from 'vitest';
import { type BrowserManagerLike, createBrowserIpcHandlers } from '../browser-ipc-handlers';

/** Tab-targeting methods return `true` only for the known id `tab-1`. */
function fakeManager(): BrowserManagerLike & { readonly calls: string[] } {
  const calls: string[] = [];
  const known = (tabId: string) => tabId === 'tab-1';
  return {
    calls,
    closeTab: (tabId) => {
      calls.push(`close:${tabId}`);
      return known(tabId);
    },
    createTab: (url) => {
      calls.push(`create:${url ?? ''}`);
      return 'tab-1';
    },
    goBack: (tabId) => {
      calls.push(`back:${tabId}`);
      return known(tabId);
    },
    goForward: (tabId) => {
      calls.push(`forward:${tabId}`);
      return known(tabId);
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
    navigate: (tabId, target) => {
      calls.push(`nav:${tabId}:${target}`);
      return known(tabId);
    },
    reload: (tabId) => {
      calls.push(`reload:${tabId}`);
      return known(tabId);
    },
    selectTab: (tabId) => {
      calls.push(`select:${tabId}`);
      return known(tabId);
    },
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

  it('surfaces a structured failure for a well-formed but UNKNOWN tab id (no silent success)', () => {
    const handlers = createBrowserIpcHandlers(fakeManager());
    expect(handlers.closeTab('no-such-tab')).toMatchObject({
      error: expect.stringContaining('unknown tab'),
      ok: false,
    });
    expect(handlers.selectTab('no-such-tab')).toMatchObject({ ok: false });
    expect(handlers.navigate('no-such-tab', 'x.com')).toMatchObject({ ok: false });
  });

  it('navigate requires a tabId and a non-empty url (no back/forward literals)', () => {
    const manager = fakeManager();
    const handlers = createBrowserIpcHandlers(manager);
    expect(handlers.navigate('tab-1', '')).toMatchObject({ ok: false });
    expect(handlers.navigate('', 'x.com')).toMatchObject({ ok: false });
    expect(handlers.navigate('tab-1', 'x.com')).toEqual({ ok: true, value: undefined });
    expect(manager.calls).toEqual(['nav:tab-1:x.com']);
  });

  it('goBack/goForward/reload route to the manager and reject unknown ids', () => {
    const manager = fakeManager();
    const handlers = createBrowserIpcHandlers(manager);
    expect(handlers.goBack('tab-1')).toEqual({ ok: true, value: undefined });
    expect(handlers.goForward('tab-1')).toEqual({ ok: true, value: undefined });
    expect(handlers.reload('tab-1')).toEqual({ ok: true, value: undefined });
    expect(handlers.goBack('nope')).toMatchObject({ ok: false });
    expect(handlers.reload(7)).toMatchObject({ ok: false });
    expect(manager.calls).toEqual(['back:tab-1', 'forward:tab-1', 'reload:tab-1', 'back:nope']);
  });

  it('accepts x/y being negative (partially offscreen pane) but rejects negative width/height', () => {
    const handlers = createBrowserIpcHandlers(fakeManager());
    expect(handlers.setBounds({ height: 10, width: 20, x: -5, y: -8 })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(handlers.setBounds({ height: 10, width: -1, x: 0, y: 0 })).toMatchObject({ ok: false });
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

  it('converts an executor THROW into a structured failure for EVERY handler', () => {
    // Live regression 2026-08-07: manager.createTab threw (native attach
    // failure) and the raw TypeError propagated to the renderer as an
    // "Error invoking remote method" rejection. The contract is structured
    // results in BOTH directions — validation failures AND executor throws —
    // and it must hold for all ten verbs, not just the one that failed live.
    const throwingManager = Object.fromEntries(
      Object.keys(fakeManager())
        .filter((key) => key !== 'calls')
        .map((key) => [
          key,
          () => {
            throw new TypeError('conversion failure');
          },
        ])
    ) as unknown as ReturnType<typeof fakeManager>;
    const handlers = createBrowserIpcHandlers(throwingManager);
    const validArgs: Record<string, unknown[]> = {
      closeTab: ['tab-1'],
      createTab: ['https://x'],
      goBack: ['tab-1'],
      goForward: ['tab-1'],
      listTabs: [],
      navigate: ['tab-1', 'x.com'],
      reload: ['tab-1'],
      selectTab: ['tab-1'],
      setBounds: [{ height: 10, width: 20, x: 0, y: 0 }],
      setOccluded: [true],
    };
    for (const [verb, args] of Object.entries(validArgs)) {
      const run = handlers[verb as keyof typeof handlers] as (...a: unknown[]) => unknown;
      expect(() => run(...args), verb).not.toThrow();
      expect(run(...args), verb).toMatchObject({
        error: expect.stringContaining('conversion failure'),
        ok: false,
      });
    }
    // The arg map and the handler surface must not drift apart.
    expect(Object.keys(validArgs).sort()).toEqual(Object.keys(handlers).sort());
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
  });
});
