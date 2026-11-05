import { CommandPalette, useCommandPaletteHotkey } from '@brainstrike/ui';
import { type ReactElement, useEffect, useMemo } from 'react';
import {
  buildAppActionRegistryParts,
  buildAppCommandContext,
  createAppCommandRegistry,
} from './command-registry';
import { resolveCommandShortcuts } from './command-shortcuts';
import { useCommandPaletteStore } from './stores/command-palette-store';
import { getTabChordStrip, resolveTabChordScope } from './tab-chords/tab-chord-registry';
import { useGlobalCommandHandlers } from './use-global-command-handlers';

/**
 * The desktop preload exposes an `onOpen` bridge so the app menu's ⌘K
 * accelerator can route to the FOCUSED window. Web never defines it. The shape
 * mirrors the other `on*` preload bridges (e.g. `logging.onPreferencesUpdated`):
 * it registers a listener and returns an unsubscribe.
 */
interface CommandPaletteBridge {
  onOpen: (callback: () => void) => () => void;
}

function resolveCommandPaletteBridge(): CommandPaletteBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { commandPalette?: Partial<CommandPaletteBridge> })
    .commandPalette;
  if (!bridge || typeof bridge.onOpen !== 'function') {
    return null;
  }
  return bridge as CommandPaletteBridge;
}

/**
 * Mounts the ⌘K command palette ONCE at the visible-UI root. This component is
 * rendered only from `RootLayoutContent`, which only the visible-UI renderer
 * mounts — any hidden host renderer renders its own tree and never reaches here, so the palette and its hotkey are structurally
 * gated off those hosts (no role check needed at this layer).
 *
 * On open it rebuilds the command registry with the target captured at open
 * time (snapshot semantics — `bridgeActionToCommand` reads the target eagerly),
 * reusing the SAME capabilities/services the context-action registry exposes.
 * It also captures the focus-scoped tab strip BEFORE focus moves into the
 * palette, so the tab commands act on the strip the user was in (BST-1842).
 */
export function CommandPaletteHost(): ReactElement | null {
  const isOpen = useCommandPaletteStore((state) => state.isOpen);
  const openTarget = useCommandPaletteStore((state) => state.openTarget);
  const tabScope = useCommandPaletteStore((state) => state.tabScope);
  const open = useCommandPaletteStore((state) => state.open);
  const close = useCommandPaletteStore((state) => state.close);

  const handlers = useGlobalCommandHandlers();

  // The action/capability/service parts are stable for the window's lifetime
  // (capability detection reads the preload bridges that exist before React
  // mounts), so building them once is correct and keeps a single source of truth.
  const parts = buildAppActionRegistryParts();
  // Bindings, like the parts, are stable for the window's lifetime.
  const shortcuts = useMemo(() => resolveCommandShortcuts(), []);

  // Rebuild the registry + context with the captured open target. While closed,
  // openTarget is null, so this collapses to the targetless command set.
  // The strip is looked up when a command lists or runs, never cached: a strip
  // re-registers whenever its tabs change.
  const registry = useMemo(
    () =>
      createAppCommandRegistry({
        getTabStrip: () => (tabScope === null ? undefined : getTabChordStrip(tabScope)),
        handlers,
        parts,
        shortcuts,
        target: openTarget,
      }),
    [parts, handlers, openTarget, shortcuts, tabScope]
  );
  const context = buildAppCommandContext({ parts, target: openTarget });
  const commands = useMemo(() => registry.available(context), [registry, context]);

  const handleOpen = () => {
    open({ tabScope: resolveTabChordScope(document.activeElement) });
  };

  // Global ⌘K / Ctrl+K on web AND desktop.
  useCommandPaletteHotkey({ onOpen: handleOpen });

  // Desktop secondary path: the app menu's Cmd+K accelerator sends IPC to the
  // focused window, which the preload forwards via window.commandPalette.onOpen.
  useEffect(() => {
    const bridge = resolveCommandPaletteBridge();
    if (!bridge) {
      return;
    }
    return bridge.onOpen(handleOpen);
  }, [handleOpen]);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      handleOpen();
    } else {
      close();
    }
  };

  return (
    <CommandPalette
      commands={commands}
      context={context}
      onOpenChange={handleOpenChange}
      open={isOpen}
    />
  );
}
