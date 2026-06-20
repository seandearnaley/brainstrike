import type { GlobalCommandHandlers } from '@brainstrike/commands';
import { type DbHandle, usePGliteDatabase } from '@brainstrike/db';
import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import { CommandPalette, useCommandPaletteHotkey, useTheme } from '@brainstrike/ui';
import { type ReactElement, useCallback, useEffect, useMemo } from 'react';
import {
  type AssistantThreadRepository,
  createPgliteAssistantThreadRepository,
} from './assistant-memory-repository';
import { WORKSPACE_MEMORY_RESOURCE_ID } from './assistant-memory-resource';
import { useAssistantThreadStore } from './assistant-thread-store';
import {
  buildAppActionRegistryParts,
  buildAppCommandContext,
  createAppCommandRegistry,
} from './command-registry';
import { useCommandPaletteStore } from './stores/command-palette-store';

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
 * Resolves the targetless global command handlers from app state the layout
 * root already owns. Each is OPTIONAL: a handler we cannot wire (e.g. the
 * assistant memory DB is not ready) is simply absent, which keeps its command
 * HIDDEN — never a faked no-op (the no-silent-fallbacks contract). `quickOpen`
 * is intentionally not supplied here; it lands in PR-6.3.
 */
function useGlobalCommandHandlers(db: DbHandle | null): GlobalCommandHandlers {
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const { theme, setTheme } = useTheme();
  const createThread = useAssistantThreadStore((state) => state.createThread);

  const repository = useMemo<AssistantThreadRepository | null>(
    () => (db ? createPgliteAssistantThreadRepository(db) : null),
    [db]
  );

  // Bound only when the repository exists, so the closure captures a non-null
  // repository (no in-body null guard needed). When `db`/`repository` is null
  // this is null and the handler is omitted below.
  const newThread = useMemo<(() => Promise<void>) | null>(() => {
    if (!repository) {
      return null;
    }
    return async () => {
      await createThread(repository, WORKSPACE_MEMORY_RESOURCE_ID);
    };
  }, [repository, createThread]);

  const openSettings = useCallback(() => {
    setActiveTab('settings');
  }, [setActiveTab]);

  const toggleTheme = useCallback(() => {
    // Resolve `system` toward its effective value, then flip — so a single
    // invocation always produces a visible change.
    const effective =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
    setTheme(effective === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return useMemo<GlobalCommandHandlers>(
    () => ({
      // When the assistant memory DB / repository is not ready, newThread is
      // null and is OMITTED here. createGlobalCommands' isAvailable
      // (`newThread !== undefined`) then HIDES `thread.new` — it is never a
      // faked no-op (the no-silent-fallbacks contract). Once the DB is ready a
      // re-render supplies the handler and the command appears.
      ...(newThread ? { newThread } : {}),
      openSettings,
      toggleTheme,
    }),
    [newThread, openSettings, toggleTheme]
  );
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
