import type { ContextTarget } from '@brainstrike/context-actions';
import type { Command, CommandContext } from '@brainstrike/context-actions/commands';
import {
  addLogListener,
  configureLogger,
  createLogger,
  type LogRecord,
} from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAppCommandContext, createAppCommandRegistry } from '../command-registry';
import { buildAppActionRegistryParts } from '../context-action-registry';
import {
  mergeSlashCommands,
  runSlashCommand,
  type SlashCommandFailureToast,
  selectSlashCommandSource,
} from '../slash-command-source';

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
  // No window.platform → web capability set (clipboard only, no shell/fs).
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

describe('selectSlashCommandSource (slash-command projection)', () => {
  it('omits a desktop-only command under a WEB capability set (capability gating, no isElectron)', () => {
    const parts = webParts();
    const registry = createAppCommandRegistry({
      handlers: { newThread: () => {} },
      parts,
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
      handlers: { newThread: () => {} },
      parts,
      target: fileTarget,
    });
    const context = buildAppCommandContext({ parts, target: fileTarget });

    const ids = selectSlashCommandSource(registry, context).map((command) => command.id);
    expect(ids).toContain('file.reveal-in-os');
  });

  it('excludes the danger group (no destructive command in a one-keystroke menu)', () => {
    const dangerCommand: Command = {
      group: 'danger',
      id: 'workspace.factory-reset',
      label: 'Factory reset',
      run: () => Promise.resolve({ ok: true }),
    };
    const safeCommand: Command = {
      group: 'thread',
      id: 'thread.new',
      label: 'New thread',
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
  it('excludes page commands: a one-shot menu cannot show a follow-up page', () => {
    const pageCommand: Command = {
      id: 'tab.go-to',
      label: 'Go to Tab…',
      page: () => ({ commands: [], heading: 'Tabs', placeholder: 'Go to tab…' }),
    };
    const safeCommand: Command = {
      id: 'thread.new',
      label: 'New thread',
      run: () => Promise.resolve({ ok: true }),
    };
    const registry = {
      available: () => [pageCommand, safeCommand],
      byId: () => undefined,
      listAll: () => [pageCommand, safeCommand],
    };
    const context = buildAppCommandContext({ parts: webParts(), target: null });

    const ids = selectSlashCommandSource(registry, context).map((command) => command.id);
    expect(ids).toEqual(['thread.new']);
  });
});

describe('mergeSlashCommands (F4: app-vs-user id collision)', () => {
  it('drops a user command whose id collides with an app command, keeping the app command, and warns once', () => {
    configureLogger({ console: false });
    const records: LogRecord[] = [];
    const stop = addLogListener((record) => records.push(record));
    const logger = createLogger('AssistantSlashCommands');
    const warnedCollisionIds = new Set<string>();

    const appCommands = [{ execute: () => {}, id: 'thread.new', label: 'New thread' }];
    // A repo file named `thread.new.md` derives id `thread.new` — a direct collision.
    const userCommands = [
      { execute: () => {}, id: 'thread.new', label: 'My template' },
      { execute: () => {}, id: 'review', label: 'Review' },
    ];

    let merged: ReturnType<
      typeof mergeSlashCommands<{ execute: () => void; id: string; label: string }>
    >;
    try {
      merged = mergeSlashCommands(appCommands, userCommands, { logger, warnedCollisionIds });
      // Idempotent second call must NOT warn again (warn-once).
      mergeSlashCommands(appCommands, userCommands, { logger, warnedCollisionIds });
    } finally {
      stop();
    }

    // The colliding user command never reaches the adapter list; the app one stays.
    expect(merged.map((command) => command.id)).toEqual(['thread.new', 'review']);
    expect(merged.filter((command) => command.id === 'thread.new')).toHaveLength(1);
    expect(merged.find((command) => command.id === 'thread.new')?.label).toBe('New thread');
    const collisionWarnings = records.filter(
      (record) => record.level === 'warn' && record.message?.toLowerCase().includes('collide')
    );
    expect(collisionWarnings).toHaveLength(1);
  });
});

describe('runSlashCommand (no-silent-fallbacks failure seam)', () => {
  const context = {} as CommandContext;

  function captureErrorLogs(): { records: LogRecord[]; stop: () => void } {
    // Per the repo logging convention, assert via addLogListener — never by
    // mocking console.
    configureLogger({ console: false });
    const records: LogRecord[] = [];
    const stop = addLogListener((record) => {
      records.push(record);
    });
    return { records, stop };
  }

  it('surfaces a destructive toast + logger.error when run resolves { ok: false }', async () => {
    const toast = vi.fn<SlashCommandFailureToast>();
    const logger = createLogger('AssistantSlashCommands');
    const { records, stop } = captureErrorLogs();
    const command: Command = {
      id: 'thread.new',
      label: 'New thread',
      run: () => Promise.resolve({ error: 'boom', ok: false }),
    };

    try {
      await runSlashCommand(command, context, { logger, toast });
    } finally {
      stop();
    }

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({
      description: 'boom',
      title: 'Command failed',
      variant: 'destructive',
    });
    const errorRecord = records.find(
      (record) =>
        record.scope === 'AssistantSlashCommands' &&
        record.message?.includes('Slash command failed')
    );
    expect(errorRecord).toBeDefined();
    expect(errorRecord?.args).toContainEqual({ description: 'boom', id: 'thread.new' });
  });

  it('surfaces a destructive toast + logger.error when run REJECTS (not swallowed)', async () => {
    const toast = vi.fn<SlashCommandFailureToast>();
    const logger = createLogger('AssistantSlashCommands');
    const { records, stop } = captureErrorLogs();
    const command: Command = {
      id: 'fs.reveal',
      label: 'Reveal in Finder',
      run: () => Promise.reject(new Error('bridge exploded')),
    };

    try {
      // The rejection must be caught inside runSlashCommand — awaiting here must
      // NOT throw (the failure is surfaced, never swallowed AND never escapes).
      await expect(runSlashCommand(command, context, { logger, toast })).resolves.toBeUndefined();
    } finally {
      stop();
    }

    expect(toast).toHaveBeenCalledWith({
      description: 'bridge exploded',
      title: 'Command failed',
      variant: 'destructive',
    });
    const errorRecord = records.find(
      (record) =>
        record.scope === 'AssistantSlashCommands' &&
        record.message?.includes('Slash command failed')
    );
    expect(errorRecord?.args).toContainEqual({
      description: 'bridge exploded',
      id: 'fs.reveal',
    });
  });

  it('is silent on success (no toast, no error log)', async () => {
    const toast = vi.fn<SlashCommandFailureToast>();
    const logger = createLogger('AssistantSlashCommands');
    const { records, stop } = captureErrorLogs();
    const command: Command = {
      id: 'thread.new',
      label: 'New thread',
      run: () => Promise.resolve({ ok: true }),
    };

    try {
      await runSlashCommand(command, context, { logger, toast });
    } finally {
      stop();
    }

    expect(toast).not.toHaveBeenCalled();
    expect(
      records.some(
        (record) =>
          record.scope === 'AssistantSlashCommands' &&
          record.message?.includes('Slash command failed')
      )
    ).toBe(false);
  });
});
