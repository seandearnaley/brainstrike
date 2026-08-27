import { addLogListener, configureLogger, type LogRecord, resetLogger } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppActionRegistry } from '../context-action-registry';

// Deliberately NOT `Window & {...}`: the ambient `Window['platform']` is
// `Partial<PlatformBridge>`, and intersecting with it would reject the
// `= undefined` reset under exactOptionalPropertyTypes.
interface MutableWindow {
  platform?: unknown;
}

afterEach(() => {
  (window as MutableWindow).platform = undefined;
  resetLogger();
  vi.restoreAllMocks();
});

describe('createAppActionRegistry', () => {
  it('grants only clipboard on web (no window.platform)', () => {
    const registry = createAppActionRegistry();
    expect(registry.capabilities.has('clipboard')).toBe(true);
    expect(registry.capabilities.has('fs.reveal')).toBe(false);
  });

  it('grants fs capabilities when window.platform is fully formed', () => {
    (window as MutableWindow).platform = {
      openExternal: vi.fn(),
      openPath: vi.fn(),
      showItemInFolder: vi.fn(),
    };
    const registry = createAppActionRegistry();
    expect(registry.capabilities.has('fs.reveal')).toBe(true);
    expect(registry.capabilities.has('fs.openPath')).toBe(true);
    expect(registry.services.platformFs).toBeDefined();
  });

  it('treats a malformed bridge as absent (and the actions stay hidden)', () => {
    configureLogger({ console: false });
    (window as MutableWindow).platform = { showItemInFolder: vi.fn() };
    const registry = createAppActionRegistry();
    expect(registry.capabilities.has('fs.reveal')).toBe(false);
    expect(registry.services.platformFs).toBeUndefined();
  });

  it('logs an error when the bridge is malformed', () => {
    configureLogger({ console: false });
    (window as MutableWindow).platform = { openPath: vi.fn() };
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });

    try {
      createAppActionRegistry();
    } finally {
      unsubscribe();
    }

    const malformedRecord = records.find(
      (record) =>
        record.scope === 'PlatformBridge' &&
        record.message?.includes('window.platform bridge is malformed')
    );
    expect(malformedRecord).toBeDefined();
    expect(malformedRecord?.args).toContainEqual({
      missing: ['openExternal', 'showItemInFolder'],
    });
  });

  it('maps bridge results to action outcomes (defaults, passthrough error, success)', async () => {
    const openPath = vi
      .fn<(absolutePath: string) => Promise<{ ok: boolean; error?: string }>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ error: 'x', ok: false })
      .mockResolvedValueOnce({ ok: true });
    const showItemInFolder = vi
      .fn<(absolutePath: string) => Promise<{ ok: boolean; error?: string }>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ error: 'x', ok: false })
      .mockResolvedValueOnce({ ok: true });
    (window as MutableWindow).platform = { openExternal: vi.fn(), openPath, showItemInFolder };

    const registry = createAppActionRegistry();
    const platformFs = registry.services.platformFs;
    if (!platformFs) {
      throw new Error('platformFs service should be defined for a fully-formed bridge');
    }

    await expect(platformFs.openPath('/a')).resolves.toEqual({
      error: 'Open failed',
      ok: false,
    });
    await expect(platformFs.openPath('/a')).resolves.toEqual({ error: 'x', ok: false });
    await expect(platformFs.openPath('/a')).resolves.toEqual({ ok: true });

    await expect(platformFs.showItemInFolder('/a')).resolves.toEqual({
      error: 'Reveal failed',
      ok: false,
    });
    await expect(platformFs.showItemInFolder('/a')).resolves.toEqual({ error: 'x', ok: false });
    await expect(platformFs.showItemInFolder('/a')).resolves.toEqual({ ok: true });

    expect(openPath).toHaveBeenCalledWith('/a');
    expect(showItemInFolder).toHaveBeenCalledWith('/a');
  });

  it('includes the composed global actions', () => {
    const registry = createAppActionRegistry();
    const grouped = registry.actionsFor({ content: 'x', id: 'c', kind: 'chunk' });
    const flatIds = grouped.flatMap((group) => group.actions.map((action) => action.id));
    expect(flatIds).toContain('collection.copy-id');
    expect(flatIds).toContain('collection.copy-content');

    const threadGroups = registry.actionsFor({
      id: 'thread-a',
      kind: 'assistant-thread',
      resourceId: 'workspace-memory',
      title: 'Evidence review',
    });
    expect(threadGroups.flatMap((group) => group.actions.map((action) => action.id))).toEqual([
      'assistant-thread.copy-title',
      'assistant-thread.copy-id',
    ]);
  });

  it('composes the workspace-root actions, gated by the platform bridge', () => {
    const webRegistry = createAppActionRegistry();
    const webIds = webRegistry
      .actionsFor({
        displayName: 'notes',
        isMain: false,
        kind: 'workspace-root',
        path: null,
        rootId: 'root-web-1',
      })
      .flatMap((group) => group.actions.map((action) => action.id));
    // Web: no platform bridge (no Reveal) AND no path (no Copy Path). The
    // menu is empty, which ActionContextMenu renders as NO menu at all.
    expect(webIds).toEqual([]);

    (window as MutableWindow).platform = {
      openExternal: vi.fn(),
      openPath: vi.fn(),
      showItemInFolder: vi.fn(),
    };
    const desktopRegistry = createAppActionRegistry();
    const desktopIds = desktopRegistry
      .actionsFor({
        displayName: 'brainstrike',
        isMain: true,
        kind: 'workspace-root',
        path: '/Users/dev/GitHub/brainstrike',
        rootId: 'root-1',
      })
      .flatMap((group) => group.actions.map((action) => action.id));
    expect(desktopIds).toEqual(['workspace-root.copy-path', 'workspace-root.reveal']);
  });
});
