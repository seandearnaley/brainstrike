import type { ContextTarget } from '@brainstrike/context-actions';
import type { CommandContext, TabCommandStrip } from '@brainstrike/context-actions/commands';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAppCommandContext, createAppCommandRegistry } from '../command-registry';
import { buildAppActionRegistryParts } from '../context-action-registry';

// Deliberately NOT `Window & {...}`: the ambient `Window['platform']` is
// `Partial<PlatformBridge>`, and intersecting with it would reject the
// `= undefined` reset under exactOptionalPropertyTypes.
interface MutableWindow {
  platform?: unknown;
}

afterEach(() => {
  (window as MutableWindow).platform = undefined;
  vi.restoreAllMocks();
});

const fileTarget: ContextTarget = {
  absolutePath: '/abs/src/main.ts',
  entryType: 'file',
  kind: 'file-entry',
  name: 'main.ts',
  relativePath: 'src/main.ts',
  rootFolderId: 'root-1',
};

function webParts() {
  // No window.platform → web capability set (clipboard only).
  return buildAppActionRegistryParts();
}

function desktopParts() {
  (window as MutableWindow).platform = {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  };
  return buildAppActionRegistryParts();
}

function idsFor(registry: ReturnType<typeof createAppCommandRegistry>, ctx: CommandContext) {
  return registry.available(ctx).map((command) => command.id);
}

describe('createAppCommandRegistry', () => {
  it('composes global commands with bridged feature actions', () => {
    const parts = desktopParts();
    const registry = createAppCommandRegistry({
      handlers: { newThread: () => {}, openSettings: () => {}, toggleTheme: () => {} },
      parts,
      target: fileTarget,
    });
    const ctx = buildAppCommandContext({ parts, target: fileTarget });
    const ids = idsFor(registry, ctx);

    // Globals are present (those with handlers).
    expect(ids).toContain('thread.new');
    expect(ids).toContain('nav.settings');
    expect(ids).toContain('theme.toggle');
    // A bridged file action is present for the captured file target.
    expect(ids).toContain('file.copy-name');
  });

  it('gates a desktop-only bridged command out under a web capability set', () => {
    const parts = webParts();
    const registry = createAppCommandRegistry({
      handlers: { newThread: () => {} },
      parts,
      target: fileTarget,
    });
    const ctx = buildAppCommandContext({ parts, target: fileTarget });
    const ids = idsFor(registry, ctx);

    // fs.reveal requires the platform bridge → hidden on web (no isElectron).
    expect(ids).not.toContain('file.reveal-in-os');
    // Clipboard file actions remain available on web.
    expect(ids).toContain('file.copy-name');
  });

  it('includes the desktop-only bridged command under a desktop capability set', () => {
    const parts = desktopParts();
    const registry = createAppCommandRegistry({
      handlers: { newThread: () => {} },
      parts,
      target: fileTarget,
    });
    const ctx = buildAppCommandContext({ parts, target: fileTarget });
    expect(idsFor(registry, ctx)).toContain('file.reveal-in-os');
  });

  it('keeps palette.quickOpen hidden until a handler is supplied (no fake no-op)', () => {
    const parts = webParts();
    const registry = createAppCommandRegistry({
      handlers: { newThread: () => {} },
      parts,
      target: null,
    });
    const ctx = buildAppCommandContext({ parts, target: null });
    expect(idsFor(registry, ctx)).not.toContain('palette.quickOpen');

    const wired = createAppCommandRegistry({
      handlers: { newThread: () => {}, openQuickOpen: () => {} },
      parts,
      target: null,
    });
    expect(idsFor(wired, ctx)).toContain('palette.quickOpen');
  });

  it('rebuilds with the captured open target as the command context (snapshot semantics)', () => {
    const parts = desktopParts();

    // No target captured at open → no file-bound bridged commands.
    const targetless = createAppCommandRegistry({
      handlers: { newThread: () => {} },
      parts,
      target: null,
    });
    const targetlessCtx = buildAppCommandContext({ parts, target: null });
    const targetlessIds = idsFor(targetless, targetlessCtx);
    expect(targetlessIds).not.toContain('file.copy-name');
    expect(targetlessIds).not.toContain('file.reveal-in-os');
    // Globals still present without a target.
    expect(targetlessIds).toContain('thread.new');

    // Rebuilding with the file target now surfaces the file-bound commands.
    const withTarget = createAppCommandRegistry({
      handlers: { newThread: () => {} },
      parts,
      target: fileTarget,
    });
    const withTargetCtx = buildAppCommandContext({ parts, target: fileTarget });
    const withTargetIds = idsFor(withTarget, withTargetCtx);
    expect(withTargetIds).toContain('file.copy-name');
    expect(withTargetIds).toContain('file.reveal-in-os');
  });

  it('runs a bridged command against the snapshotted target via the shared services', async () => {
    const writeText = vi.fn(() => Promise.resolve({ ok: true as const }));
    const parts = {
      ...webParts(),
      services: { clipboard: { writeText } },
    };
    const registry = createAppCommandRegistry({
      handlers: {},
      parts,
      target: fileTarget,
    });
    const ctx = buildAppCommandContext({ parts, target: fileTarget });
    const copyName = registry.available(ctx).find((command) => command.id === 'file.copy-name');
    if (!copyName || copyName.page) {
      throw new Error('file.copy-name must be a runnable command');
    }
    await copyName.run(ctx);
    expect(writeText).toHaveBeenCalledWith('main.ts');
  });

  it('adds the tab commands only for a caller that resolves a focus-scoped strip', () => {
    const parts = webParts();
    const ctx = buildAppCommandContext({ parts, target: null });
    const strip: TabCommandStrip = {
      activate: vi.fn(),
      close: vi.fn(),
      getActiveId: () => 'a',
      getTabs: () => [{ id: 'a', label: 'A' }],
      reopenClosed: () => Promise.resolve({ ok: true }),
    };
    const tabIds = (registry: ReturnType<typeof createAppCommandRegistry>) =>
      idsFor(registry, ctx).filter((id) => id.startsWith('tab.'));

    expect(tabIds(createAppCommandRegistry({ handlers: {}, parts, target: null }))).toEqual([]);
    expect(
      tabIds(
        createAppCommandRegistry({
          getTabStrip: () => undefined,
          handlers: {},
          parts,
          target: null,
        })
      )
    ).toEqual([]);
    expect(
      tabIds(
        createAppCommandRegistry({ getTabStrip: () => strip, handlers: {}, parts, target: null })
      )
    ).toEqual(['tab.close', 'tab.reopen-closed', 'tab.next', 'tab.previous', 'tab.go-to']);
  });
});
