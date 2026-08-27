import { describe, expect, it, vi } from 'vitest';
import {
  type ActionOutcome,
  type ActionServices,
  type AnyContextAction,
  type ContextTarget,
  defineContextAction,
} from '../../index.js';
import { bridgeActionToCommand } from '../bridge-action-to-command.js';
import { createCommandRegistry } from '../command-registry.js';
import { createGlobalCommands } from '../global-commands.js';
import type { Command, CommandCapability, CommandContext } from '../types.js';

const EMPTY_SERVICES: ActionServices = {};

function makeContext(
  capabilities: readonly CommandCapability[],
  overrides: Partial<CommandContext> = {}
): CommandContext {
  return {
    capabilities: new Set(capabilities),
    services: EMPTY_SERVICES,
    ...overrides,
  };
}

const fileTarget: ContextTarget = {
  absolutePath: '/abs/src/main.ts',
  entryType: 'file',
  kind: 'file-entry',
  name: 'main.ts',
  relativePath: 'src/main.ts',
  rootFolderId: 'root-1',
};

const collectionTarget: ContextTarget = {
  id: 'col-1',
  kind: 'collection',
  name: 'Docs',
};

describe('createCommandRegistry', () => {
  it('hides a command whose required capabilities exceed the context set', () => {
    const restricted: Command = {
      id: 'fs.reveal',
      label: 'Reveal in Finder',
      requiredCapabilities: ['fs.reveal'],
      run: () => Promise.resolve<ActionOutcome>({ ok: true }),
    };
    const always: Command = {
      id: 'thread.new',
      label: 'New Thread',
      run: () => Promise.resolve<ActionOutcome>({ ok: true }),
    };
    const registry = createCommandRegistry([restricted, always]);

    const webAvailable = registry.available(makeContext(['clipboard']));
    expect(webAvailable.map((command) => command.id)).toEqual(['thread.new']);

    const desktopAvailable = registry.available(makeContext(['clipboard', 'fs.reveal']));
    expect(desktopAvailable.map((command) => command.id)).toEqual(['fs.reveal', 'thread.new']);
  });

  it('respects an isAvailable predicate alongside capability gating', () => {
    const targetBound: Command = {
      id: 'file.copy',
      isAvailable: (ctx) => ctx.target?.kind === 'file-entry',
      label: 'Copy Name',
      run: () => Promise.resolve<ActionOutcome>({ ok: true }),
    };
    const registry = createCommandRegistry([targetBound]);

    expect(registry.available(makeContext([])).map((c) => c.id)).toEqual([]);
    expect(registry.available(makeContext([], { target: fileTarget })).map((c) => c.id)).toEqual([
      'file.copy',
    ]);
  });

  it('throws on a duplicate command id rather than silently keeping the last', () => {
    const a: Command = { id: 'dup', label: 'A', run: () => Promise.resolve({ ok: true }) };
    const b: Command = { id: 'dup', label: 'B', run: () => Promise.resolve({ ok: true }) };
    expect(() => createCommandRegistry([a, b])).toThrow(/dup/);
  });

  it('byId resolves a registered command and undefined otherwise', () => {
    const command: Command = {
      id: 'thread.new',
      label: 'New Thread',
      run: () => Promise.resolve<ActionOutcome>({ ok: true }),
    };
    const registry = createCommandRegistry([command]);
    expect(registry.byId('thread.new')).toBe(command);
    expect(registry.byId('missing')).toBeUndefined();
  });
});

describe('bridgeActionToCommand', () => {
  const copyName: AnyContextAction = defineContextAction({
    appliesTo: ['file-entry'],
    group: 'copy',
    id: 'file.copy-name',
    label: 'Copy Name',
    requiredCapabilities: ['clipboard'],
    run: (target, services) =>
      services.clipboard
        ? services.clipboard.writeText(target.name)
        : Promise.resolve<ActionOutcome>({ error: 'no clipboard', ok: false }),
  });

  const revealInOs: AnyContextAction = defineContextAction({
    appliesTo: ['file-entry'],
    group: 'navigate',
    id: 'file.reveal-in-os',
    isVisible: (target) => target.absolutePath !== null,
    // Dynamic label — must be materialized to a static string by the bridge.
    label: () => 'Reveal in Finder',
    requiredCapabilities: ['fs.reveal'],
    run: () => Promise.resolve<ActionOutcome>({ ok: true }),
  });

  it('returns null when no target is present', () => {
    expect(bridgeActionToCommand(copyName, () => null)).toBeNull();
    expect(bridgeActionToCommand(copyName, () => undefined)).toBeNull();
  });

  it('returns null for a target whose kind the action does not apply to', () => {
    expect(bridgeActionToCommand(copyName, () => collectionTarget)).toBeNull();
  });

  it('returns null when the action isVisible gate fails for the target', () => {
    const webFileTarget: ContextTarget = { ...fileTarget, absolutePath: null };
    expect(bridgeActionToCommand(revealInOs, () => webFileTarget)).toBeNull();
  });

  it('returns a runnable Command for a matching target, preserving capabilities', () => {
    const command = bridgeActionToCommand(copyName, () => fileTarget);
    expect(command).not.toBeNull();
    expect(command?.id).toBe('file.copy-name');
    expect(command?.label).toBe('Copy Name');
    expect(command?.requiredCapabilities).toEqual(['clipboard']);
    expect(command?.group).toBe('file');
  });

  it('materializes a dynamic action label to a static string', () => {
    const command = bridgeActionToCommand(revealInOs, () => fileTarget);
    expect(command?.label).toBe('Reveal in Finder');
  });

  it('injects the captured target into the wrapped run', async () => {
    const writeText = vi.fn(() => Promise.resolve<ActionOutcome>({ ok: true }));
    const command = bridgeActionToCommand(copyName, () => fileTarget);
    expect(command).not.toBeNull();
    await command?.run(makeContext(['clipboard'], { services: { clipboard: { writeText } } }));
    expect(writeText).toHaveBeenCalledWith('main.ts');
  });
});

describe('capability gating proof: desktop-only command absent on web', () => {
  // The canonical proof for the palette's capability contract: a command that
  // projects a desktop-only context action (`fs.reveal`) must be HIDDEN under a
  // web capability set, and visible under a desktop one — purely via
  // capabilities, with no isElectron branch anywhere.
  const revealAction: AnyContextAction = defineContextAction({
    appliesTo: ['file-entry'],
    group: 'navigate',
    id: 'file.reveal-in-os',
    label: 'Reveal in Finder',
    requiredCapabilities: ['fs.reveal'],
    run: () => Promise.resolve<ActionOutcome>({ ok: true }),
  });

  function buildAppCommands(): readonly Command[] {
    const globals = createGlobalCommands({ newThread: () => {}, openSettings: () => {} });
    const bridged = bridgeActionToCommand(revealAction, () => fileTarget);
    return bridged ? [...globals, bridged] : [...globals];
  }

  it('omits the fs.reveal command under a web capability set', () => {
    const registry = createCommandRegistry(buildAppCommands());
    const webCapabilities: readonly CommandCapability[] = ['clipboard'];
    const available = registry.available(makeContext(webCapabilities));
    expect(available.some((command) => command.id === 'file.reveal-in-os')).toBe(false);
    // The global, capability-free commands are still present on web.
    expect(available.some((command) => command.id === 'thread.new')).toBe(true);
  });

  it('includes the fs.reveal command under a desktop capability set', () => {
    const registry = createCommandRegistry(buildAppCommands());
    const desktopCapabilities: readonly CommandCapability[] = [
      'clipboard',
      'fs.reveal',
      'fs.openPath',
    ];
    const available = registry.available(makeContext(desktopCapabilities));
    expect(available.some((command) => command.id === 'file.reveal-in-os')).toBe(true);
  });
});

describe('createGlobalCommands', () => {
  it('gates out a command whose handler is absent (not a fake no-op)', () => {
    const commands = createGlobalCommands({ newThread: () => {} });
    const ctx = makeContext([]);
    const available = commands.filter((command) => command.isAvailable?.(ctx) ?? true);
    expect(available.map((command) => command.id)).toEqual(['thread.new']);
    // quickOpen has no handler yet → hidden, never offered as a stub.
    expect(available.some((command) => command.id === 'palette.quickOpen')).toBe(false);
  });

  it('runs a supplied handler and reports a thrown handler as a failure outcome', async () => {
    const newThread = vi.fn();
    const openSettings = vi.fn(() => {
      throw new Error('boom');
    });
    const commands = createGlobalCommands({ newThread, openSettings });
    const byId = new Map(commands.map((command) => [command.id, command]));

    const ok = await byId.get('thread.new')?.run(makeContext([]));
    expect(ok).toEqual({ ok: true });
    expect(newThread).toHaveBeenCalledTimes(1);

    const failure = await byId.get('nav.settings')?.run(makeContext([]));
    expect(failure).toEqual({ error: 'boom', ok: false });
  });

  it('gates the open-folder command on whether a handler is supplied', () => {
    const withoutHandler = createGlobalCommands({ newThread: () => {} });
    const ctx = makeContext([]);
    expect(
      withoutHandler
        .filter((command) => command.isAvailable?.(ctx) ?? true)
        .some((command) => command.id === 'global.open-folder')
    ).toBe(false);

    const openFolder = vi.fn();
    const withHandler = createGlobalCommands({ newThread: () => {}, openFolder });
    const available = withHandler.filter((command) => command.isAvailable?.(ctx) ?? true);
    expect(available.some((command) => command.id === 'global.open-folder')).toBe(true);
  });

  it('runs the supplied open-folder handler', async () => {
    const openFolder = vi.fn();
    const commands = createGlobalCommands({ openFolder });
    const command = commands.find((c) => c.id === 'global.open-folder');
    const outcome = await command?.run(makeContext([]));
    expect(outcome).toEqual({ ok: true });
    expect(openFolder).toHaveBeenCalledTimes(1);
  });
});
