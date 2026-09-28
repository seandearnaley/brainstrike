import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import type { FileExplorerState } from '@brainstrike/types';
import type { OpenFileInTab } from '@brainstrike/ui';
import { createContext, useContext } from 'react';
import type { FileTab } from '../hooks/use-tab-manager';
import type { WorkspaceTabSelection } from '../stores/workspace-tab-selection-store';
import type { WorkspaceApp } from './workspace-app';

export interface WorkspaceTabsValue {
  /** Full app registry, in canonical display order. */
  readonly apps: readonly WorkspaceApp[];
  readonly fileContentErrors: ReadonlyMap<string, Error>;
  readonly fileContents: { readonly [key: string]: string };
  readonly getTabStatusMessage: (compositeKey: string) => string | null;
  /** The registered open-file seam — `WorkspaceOpenFileBridge` registers it. */
  readonly handleOpenFileInTab: OpenFileInTab;
  readonly isRestoring: boolean;
  readonly loadingFiles: Set<string>;
  /** Apps activated at least once this session — rendered hidden-but-mounted. */
  readonly mountedAppIds: ReadonlySet<string>;
  readonly onCloseAllFileTabs: () => void;
  readonly onCloseApp: (appId: string) => void;
  /** Close several app tabs atomically (app-tab menu Close Others / Close All). */
  readonly onCloseApps: (appIds: readonly string[]) => void;
  readonly onCloseFileTab: (tabId: string) => void;
  readonly onCloseFileTabsToRight: (tabId: string) => void;
  readonly onCloseOtherFileTabs: (tabId: string) => void;
  readonly onOpenApp: (appId: string) => void;
  /** Adopt a new file-tab order; anything but a permutation of the open tabs is rejected. */
  readonly onReorderFileTabs: (orderedTabIds: readonly string[]) => void;
  readonly onRetryFileContent: (compositeKey: string) => void;
  readonly onSelectFileTab: (tabId: string) => void | Promise<void>;
  /** Registry ∩ openAppIds, in registry order — what the strip renders. */
  readonly openApps: readonly WorkspaceApp[];
  readonly rootDescriptors: FileExplorerState['rootDescriptors'];
  readonly selection: WorkspaceTabSelection;
  readonly tabStatuses: Map<string, TabFileStatus>;
  readonly tabs: readonly FileTab[];
}

export const WorkspaceTabsContext = createContext<WorkspaceTabsValue | null>(null);

export function useWorkspaceTabs(): WorkspaceTabsValue {
  const value = useContext(WorkspaceTabsContext);
  if (value === null) {
    // NO SILENT FALLBACKS: a strip/body rendered outside the provider would
    // otherwise render an empty workspace and hide the wiring bug.
    throw new Error('useWorkspaceTabs must be used within a WorkspaceTabsProvider');
  }
  return value;
}
