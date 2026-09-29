import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { FileExplorerState } from '@brainstrike/types';
import type { FileTab } from '../hooks/use-tab-manager';
import type { WorkspaceTabSelection } from '../stores/workspace-tab-selection-store';

export function getFileName(path: string): string {
  const last = path.split('/').pop();
  return last && last.length > 0 ? last : path;
}

export function getTabRootPath(
  tab: Pick<FileTab, 'compositeKey'>,
  rootDescriptors: FileExplorerState['rootDescriptors']
): string | null {
  try {
    const { folderId } = decodeFileSelection(tab.compositeKey);
    return rootDescriptors[folderId]?.path ?? null;
  } catch {
    return null;
  }
}

/** The strip id of the selected workspace tab, or null on the empty launcher. */
export function selectedWorkspaceTabId(selection: WorkspaceTabSelection): string | null {
  switch (selection.kind) {
    case 'app':
      return selection.appId;
    case 'file':
      return selection.tabId;
    case 'empty':
      return null;
  }
}

/**
 * Whether this bundle is running inside the Electron renderer (the desktop app exposes
 * `window.electronAPI` via preload). Called from event handlers, not module init —
 * evaluating at module-load time would race against the preload script, leaving the
 * value `false` for an entire session if this module imports before preload completes.
 * The cost of a lazy property check on each keystroke is negligible.
 */
export function isDesktopRenderer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as Window & { electronAPI?: unknown }).electronAPI !== 'undefined'
  );
}
