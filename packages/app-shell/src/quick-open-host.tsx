import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import {
  type QuickOpenFileItem,
  QuickOpenPalette,
  useIdeFileEditor,
  useQuickOpenHotkey,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useQuickOpenStore } from './stores/quick-open-store';
import { useQuickOpenFiles } from './use-quick-open-files';

const logger = createLogger('QuickOpenHost');

/**
 * The desktop preload exposes a `quickOpen.onOpen` bridge so the app menu's ⌘P
 * accelerator can route to the FOCUSED window. Web never defines it. Mirrors the
 * `commandPalette.onOpen` bridge — registers a listener, returns an unsubscribe.
 */
interface QuickOpenBridge {
  onOpen: (callback: () => void) => () => void;
}

function resolveQuickOpenBridge(): QuickOpenBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { quickOpen?: Partial<QuickOpenBridge> }).quickOpen;
  if (!bridge || typeof bridge.onOpen !== 'function') {
    return null;
  }
  return bridge as QuickOpenBridge;
}

/**
 * Mounts the ⌘P quick-open file finder. Rendered INSIDE the IdeLayout subtree
 * (where `IdeFileEditorContext` is populated by `workspace-tab-host`), so
 * `useIdeFileEditor().openFileInTab` resolves. That subtree is always mounted
 * (the explorer route is only toggled hidden, never unmounted), so ⌘P works from
 * any tab; opening a file switches to the explorer tab so the new tab is visible.
 *
 * Structural gating: only the visible-UI renderer mounts RootLayoutContent →
 * this host. Hidden embedding/llm/chunking hosts never reach here, so the hotkey
 * and palette are gated off them with no role check.
 *
 * No-silent-fallbacks: when the file-open seam is not registered yet (the editor
 * context has no `openFileInTab`), selection logs and leaves the palette open
 * rather than silently swallowing the open — but in practice the seam is always
 * registered because this host lives inside the IdeLayout that registers it.
 */
export function QuickOpenHost(): ReactElement {
  const isOpen = useQuickOpenStore((state) => state.isOpen);
  const open = useQuickOpenStore((state) => state.open);
  const close = useQuickOpenStore((state) => state.close);
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const { openFileInTab } = useIdeFileEditor();

  const [query, setQuery] = useState('');
  const { files, loading } = useQuickOpenFiles(query);

  // Global ⌘P / Ctrl+P on web AND desktop.
  useQuickOpenHotkey({ onOpen: open });

  // Desktop secondary path: the app menu's Cmd+P accelerator sends IPC to the
  // focused window, which the preload forwards via window.quickOpen.onOpen.
  useEffect(() => {
    const bridge = resolveQuickOpenBridge();
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

  const handleSelect = useCallback(
    (file: QuickOpenFileItem) => {
      if (!openFileInTab) {
        // The open seam is not registered (editor context absent). Surface it
        // honestly instead of silently dropping the open.
        logger.error('Quick-open selected a file but the file-open seam is unavailable', {
          compositeKey: file.compositeKey,
        });
        return;
      }
      // Switch to the explorer tab so the newly opened file tab is visible, then
      // open it by its root-disambiguated compositeKey.
      setActiveTab('explorer');
      openFileInTab(file.compositeKey);
    },
    [openFileInTab, setActiveTab]
  );

  return (
    <QuickOpenPalette
      files={files}
      loading={loading}
      onOpenChange={handleOpenChange}
      onQueryChange={setQuery}
      onSelect={handleSelect}
      open={isOpen}
      query={query}
    />
  );
}
