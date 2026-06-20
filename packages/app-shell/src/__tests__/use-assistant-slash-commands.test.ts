import type { Command } from '@brainstrike/commands';
import type { ContextTarget } from '@brainstrike/context-actions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAppCommandContext, createAppCommandRegistry } from '../command-registry';
import { buildAppActionRegistryParts } from '../context-action-registry';
import { selectSlashCommandSource } from '../slash-command-source';

type MutableWindow = Window & { platform?: unknown };

afterEach(() => {
  (window as MutableWindow).platform = undefined;
  vi.restoreAllMocks();
});

const fileTarget: ContextTarget = {
  kind: 'file-entry',
  name: 'main.ts',
  relativePath: 'src/main.ts',
  absolutePath: '/abs/src/main.ts',
  entryType: 'file',
  rootFolderId: 'root-1',
};

function webParts() {
  // No window.platform → web capability set (clipboard only, no shell/fs).
  return buildAppActionRegistryParts();
}

function desktopParts() {
  (window as MutableWindow).platform = {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  };
  return buildAppActionRegistryParts();
}

describe('selectSlashCommandSource (slash-command projection)', () => {
  it('omits a desktop-only command under a WEB capability set (capability gating, no isElectron)', () => {
    const parts = webParts();
    const registry = createAppCommandRegistry({
      parts,
      handlers: { newThread: () => {} },
      target: fileTarget,
    });
    const context = buildAppCommandContext({ parts, target: fileTarget });

    const ids = selectSlashCommandSource(registry, context).map((command) => command.id);

    // The desktop-only "reveal in OS" command requires the platform bridge,
    // which web never constructs → absent from the slash menu.
    expect(ids).not.toContain('file.reveal-in-os');
    // A clipboard-backed file command is still available on web.
    expect(ids).toContain('file.copy-name');
  });

  it('includes the desktop-only command under a DESKTOP capability set', () => {
    const parts = desktopParts();
    const registry = createAppCommandRegistry({
      parts,
      handlers: { newThread: () => {} },
      target: fileTarget,
    });
    const context = buildAppCommandContext({ parts, target: fileTarget });

    const ids = selectSlashCommandSource(registry, context).map((command) => command.id);
    expect(ids).toContain('file.reveal-in-os');
  });

  it('excludes the danger group (no destructive command in a one-keystroke menu)', () => {
    const dangerCommand: Command = {
      id: 'workspace.factory-reset',
      label: 'Factory reset',
      group: 'danger',
      run: () => Promise.resolve({ ok: true }),
    };
    const safeCommand: Command = {
      id: 'thread.new',
      label: 'New thread',
      group: 'thread',
      run: () => Promise.resolve({ ok: true }),
    };
    // Minimal registry stub returning both commands as "available".
    const registry = {
      available: () => [dangerCommand, safeCommand],
      byId: () => undefined,
      listAll: () => [dangerCommand, safeCommand],
    };
    const context = buildAppCommandContext({ parts: webParts(), target: null });

    const ids = selectSlashCommandSource(registry, context).map((command) => command.id);
    expect(ids).toContain('thread.new');
    expect(ids).not.toContain('workspace.factory-reset');
  });
});
