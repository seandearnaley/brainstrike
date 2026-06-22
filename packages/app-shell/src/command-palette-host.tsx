import { usePGliteDatabase } from '@brainstrike/db';
import { CommandPalette, useCommandPaletteHotkey } from '@brainstrike/ui';
import { type ReactElement, useCallback, useEffect, useMemo } from 'react';
import {
  buildAppActionRegistryParts,
  buildAppCommandContext,
  createAppCommandRegistry,
} from './command-registry';
import { useCommandPaletteStore } from './stores/command-palette-store';
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
 * mounts — the hidden embedding/llm/chunking host renderers render their own
 * trees and never reach here, so the palette and its hotkey are structurally
 * gated off those hosts (no role check needed at this layer).
 *
 * On open it rebuilds the command registry with the target captured at open
 * time (snapshot semantics — `bridgeActionToCommand` reads the target eagerly),
 * reusing the SAME capabilities/services the context-action registry exposes.
 */
export function CommandPaletteHost(): ReactElement | null {
  const db = usePGliteDatabase();
  const isOpen = useCommandPaletteStore((state) => state.isOpen);
  const openTarget = useCommandPaletteStore((state) => state.openTarget);
  const open = useCommandPaletteStore((state) => state.open);
  const close = useCommandPaletteStore((state) => state.close);

  const handlers = useGlobalCommandHandlers(db);

  // The action/capability/service parts are stable for the window's lifetime
  // (capability detection reads the preload bridges that exist before React
  // mounts), so building them once is correct and keeps a single source of truth.
  const parts = useMemo(() => buildAppActionRegistryParts(), []);

  // Rebuild the registry + context with the captured open target. While closed,
  // openTarget is null, so this collapses to the targetless command set.
  const registry = useMemo(
    () => createAppCommandRegistry({ parts, handlers, target: openTarget }),
    [parts, handlers, openTarget]
  );
  const context = useMemo(
    () => buildAppCommandContext({ parts, target: openTarget }),
    [parts, openTarget]
  );
  const commands = useMemo(() => registry.available(context), [registry, context]);

  const handleOpen = useCallback(() => {
    open();
  }, [open]);

  // Global ⌘K / Ctrl+K on web AND desktop.
  useCommandPaletteHotkey({ onOpen: handleOpen });

  // Desktop secondary path: the app menu's Cmd+K accelerator sends IPC to the
  // focused window, which the preload forwards via window.commandPalette.onOpen.
  useEffect(() => {
    const bridge = resolveCommandPaletteBridge();
    if (!bridge) {
      return;
    }
    return bridge.onOpen(() => {
      open();
    });
  }, [open]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        open();
      } else {
        close();
      }
    },
    [open, close]
  );

  return (
    <CommandPalette
      commands={commands}
      context={context}
      onOpenChange={handleOpenChange}
      open={isOpen}
    />
  );
}
