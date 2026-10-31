import type { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  type BrowserManagerLike,
  browserArgs,
  createBrowserIpcHandlers,
} from '../browser-ipc-handlers';
import { ipcArgsDecoder } from '../platform/ipc-args';

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
    createTab: (threadId, url) => {
      calls.push(`create:${threadId}:${url ?? ''}`);
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
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
          owner: 'user',
          tabId: 'tab-1',
          threadId: 'thread-1',
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
    setBounds: (rect) => calls.push(`bounds:${rect.x},${rect.y},${rect.width},${rect.height}`),
    setOccluded: (occluded) => calls.push(`occl:${occluded}`),
    showTab: (tabId) => {
      calls.push(`show:${tabId}`);
      return known(tabId);
    },
  };
}

const decodeArgs = <Args extends readonly unknown[]>(
  schema: Schema.Decoder<Args>,
  args: readonly unknown[]
) => ipcArgsDecoder('browser', schema)(args);

describe('browser IPC argument schemas', () => {
  it('accepts a thread-filed tab with or without a url', () => {
    expect(decodeArgs(browserArgs.createTab, ['thread-1', 'example.com'])).toEqual([
      'thread-1',
      'example.com',
    ]);
    expect(decodeArgs(browserArgs.createTab, ['thread-1'])).toEqual(['thread-1']);
    expect(() => decodeArgs(browserArgs.createTab, ['', 'example.com'])).toThrow(TypeError);
    expect(() => decodeArgs(browserArgs.createTab, ['thread-1', 42])).toThrow(TypeError);
  });

  it('requires a non-empty tab id and url', () => {
    expect(() => decodeArgs(browserArgs.closeTab, [''])).toThrow(TypeError);
    expect(() => decodeArgs(browserArgs.navigate, ['tab-1', ''])).toThrow(TypeError);
    expect(decodeArgs(browserArgs.navigate, ['tab-1', 'x.com'])).toEqual(['tab-1', 'x.com']);
  });

  it('accepts an offscreen pane but rejects negative or non-finite extents and extra keys', () => {
    expect(decodeArgs(browserArgs.setBounds, [{ height: 10, width: 20, x: -5, y: -8 }])).toEqual([
      { height: 10, width: 20, x: -5, y: -8 },
    ]);
    for (const rect of [
      { height: 10, width: -1, x: 0, y: 0 },
      { height: 10, width: 20, x: 1, y: Number.NaN },
      { evil: 1, height: 10, width: 20, x: 1, y: 2 },
      null,
    ]) {
      expect(() => decodeArgs(browserArgs.setBounds, [rect])).toThrow(TypeError);
    }
  });
});

describe('createBrowserIpcHandlers', () => {
  it('routes each verb to the manager', () => {
    const manager = fakeManager();
    const handlers = createBrowserIpcHandlers(manager);
    expect(handlers.createTab('thread-1', 'example.com')).toEqual({ ok: true, value: 'tab-1' });
    expect(handlers.closeTab('tab-1')).toEqual({ ok: true, value: undefined });
    expect(handlers.navigate('tab-1', 'x.com')).toEqual({ ok: true, value: undefined });
    expect(handlers.goBack('tab-1')).toEqual({ ok: true, value: undefined });
    expect(handlers.goForward('tab-1')).toEqual({ ok: true, value: undefined });
    expect(handlers.reload('tab-1')).toEqual({ ok: true, value: undefined });
    expect(handlers.setBounds({ height: 10, width: 20, x: 1, y: 2 })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(handlers.setOccluded(true)).toEqual({ ok: true, value: undefined });
    expect(manager.calls).toEqual([
      'create:thread-1:example.com',
      'close:tab-1',
      'nav:tab-1:x.com',
      'back:tab-1',
      'forward:tab-1',
      'reload:tab-1',
      'bounds:1,2,20,10',
      'occl:true',
    ]);
  });

  it('surfaces a structured failure for a well-formed but UNKNOWN tab id (no silent success)', () => {
    const handlers = createBrowserIpcHandlers(fakeManager());
    expect(handlers.closeTab('no-such-tab')).toMatchObject({
      error: expect.stringContaining('unknown tab'),
      ok: false,
    });
    expect(handlers.showTab('no-such-tab')).toMatchObject({ ok: false });
    expect(handlers.navigate('no-such-tab', 'x.com')).toMatchObject({ ok: false });
    expect(handlers.goBack('nope')).toMatchObject({ ok: false });
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
      createTab: ['thread-1', 'https://x'],
      goBack: ['tab-1'],
      goForward: ['tab-1'],
      listTabs: [],
      navigate: ['tab-1', 'x.com'],
      reload: ['tab-1'],
      setBounds: [{ height: 10, width: 20, x: 0, y: 0 }],
      setOccluded: [true],
      showTab: ['tab-1'],
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
});
