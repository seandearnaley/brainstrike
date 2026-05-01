import { type TabFileStatus, useTabFileRestoration } from '@brainstrike/file-explorer-hooks';
import { Button, cn, useIdeFileEditor } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { decodeFileSelection } from '@brainstrike/utils/selection-utils';
import { AlertCircle, File, LayoutGrid, Loader2, LockKeyhole, X } from 'lucide-react';
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { FileExplorerMiddlePanelBase } from './file-explorer-middle-panel-base';
import { type FileTab, useTabManager } from './hooks/use-tab-manager';
import { useEditorViewStateStore } from './stores/editor-view-state-store';
import {
  useWorkspaceTabSelectionStore,
  type WorkspaceTabSelection,
} from './stores/workspace-tab-selection-store';
import { useFileExplorer } from './use-file-explorer-context';
import { CONTEXT_EXPLORER_APP_ID, type WorkspaceApp } from './workspace-app';

const logger = createLogger('WorkspaceTabHost');

/** Hard cap on how much text we paint into the DOM per panel. Beyond this we truncate visibly. */
const MAX_DOM_CHARS = 200_000;

const CONTEXT_EXPLORER_APP: WorkspaceApp = {
  id: CONTEXT_EXPLORER_APP_ID,
  label: 'Context Explorer',
  icon: LayoutGrid,
  render: () => <FileExplorerMiddlePanelBase />,
};

export interface WorkspaceTabHostProps {
  /** Optional className applied to the outer container. */
  readonly className?: string;
  /**
   * Additional pinned apps appended after Context Explorer. The registry is intentionally
   * a typed array (not a global) so consumers compose statically and tests stay deterministic.
   */
  readonly extraApps?: readonly WorkspaceApp[];
}

export const WorkspaceTabHost = memo<WorkspaceTabHostProps>(function WorkspaceTabHost({
  className,
  extraApps,
}) {
  const apps = useMemo<readonly WorkspaceApp[]>(
    () => [CONTEXT_EXPLORER_APP, ...(extraApps ?? [])],
    [extraApps]
  );

  const { tabs, activeTabId, openTab, closeTab, setActiveTab, clearTabs } = useTabManager();
  const { fileContents, loadingFiles, loadFileContent, fileTree, canLoadWithoutTree } =
    useFileExplorer();

  const selection = useWorkspaceTabSelectionStore((s) => s.selection);
  const selectApp = useWorkspaceTabSelectionStore((s) => s.selectApp);
  const selectFile = useWorkspaceTabSelectionStore((s) => s.selectFile);

  // Restoration plumbing: surfaces persisted-tab status (restored / needs-permission / not-found).
  const { tabStatuses, requestTabPermission, getStatusMessage, isRestoring } =
    useTabFileRestoration(tabs, (tabId: string) => {
      closeTab(tabId);
      // If the closed tab was active in the workspace, fall back to Context Explorer.
      if (selection.kind === 'file' && selection.tabId === tabId) {
        selectApp(CONTEXT_EXPLORER_APP_ID);
      }
    });

  // Track in-flight permission requests to ignore double-clicks.
  const permissionRequestsInProgressRef = useRef<Set<string>>(new Set());

  const handleSelectApp = useCallback(
    (appId: string) => {
      selectApp(appId);
    },
    [selectApp]
  );

  const handleSelectFileTab = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) {
        return;
      }
      const status = tabStatuses.get(tab.compositeKey);
      // Permission requests must happen synchronously from the user gesture.
      if (
        status?.status === 'needs-permission' &&
        !permissionRequestsInProgressRef.current.has(tab.compositeKey)
      ) {
        permissionRequestsInProgressRef.current.add(tab.compositeKey);
        try {
          const granted = await requestTabPermission(tab.compositeKey);
          if (granted) {
            void loadFileContent(tab.compositeKey);
          }
        } catch (err) {
          logger.error('Failed to request file permission', {
            compositeKey: tab.compositeKey,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          permissionRequestsInProgressRef.current.delete(tab.compositeKey);
        }
      }
      setActiveTab(tabId);
      selectFile(tabId);
    },
    [tabs, tabStatuses, requestTabPermission, loadFileContent, setActiveTab, selectFile]
  );

  const handleCloseFileTab = useCallback(
    (tabId: string) => {
      closeTab(tabId);
      // After closing, if this was the selected file, route back to Context Explorer.
      if (selection.kind === 'file' && selection.tabId === tabId) {
        selectApp(CONTEXT_EXPLORER_APP_ID);
      }
    },
    [closeTab, selection, selectApp]
  );

  // Auto-load active file content when tabs/file tree become ready.
  // biome-ignore lint/plugin: reactive content load — necessary side effect on activation
  useEffect(() => {
    if (selection.kind !== 'file') {
      return;
    }
    const tab = tabs.find((t) => t.id === selection.tabId);
    if (!tab) {
      return;
    }
    if (!canLoadWithoutTree && fileTree.length === 0) {
      return;
    }
    if (fileContents[tab.compositeKey] !== undefined) {
      return;
    }
    if (loadingFiles.has(tab.compositeKey)) {
      return;
    }
    const status = tabStatuses.get(tab.compositeKey);
    // Skip auto-load if the tab needs an explicit user gesture for permission.
    if (status && status.status !== 'restored') {
      return;
    }
    void loadFileContent(tab.compositeKey);
  }, [
    selection,
    tabs,
    fileContents,
    loadingFiles,
    tabStatuses,
    canLoadWithoutTree,
    fileTree,
    loadFileContent,
  ]);

  // Register openFileInTab so the FileExplorer side panel can drive opens.
  const fileContentsRef = useRef(fileContents);
  const loadingFilesRef = useRef(loadingFiles);
  useLayoutEffect(() => {
    fileContentsRef.current = fileContents;
  });
  useLayoutEffect(() => {
    loadingFilesRef.current = loadingFiles;
  });

  const { registerOpenFileInTab } = useIdeFileEditor();
  const handleOpenFileInTab = useCallback(
    (compositeKey: string) => {
      const { path } = decodeFileSelection(compositeKey);
      // tabId is the compositeKey itself — stable across reloads (it already encodes the
      // folder identity), unlike the legacy `${rootFolderId}:${compositeKey}` form.
      const tabId = compositeKey;
      openTab(path, tabId, compositeKey);
      selectFile(tabId);
      if (
        fileContentsRef.current[compositeKey] === undefined &&
        !loadingFilesRef.current.has(compositeKey)
      ) {
        void loadFileContent(compositeKey);
      }
    },
    [openTab, selectFile, loadFileContent]
  );
  useEffect(() => {
    registerOpenFileInTab(handleOpenFileInTab);
  }, [registerOpenFileInTab, handleOpenFileInTab]);

  // Hotkeys: ctrl/cmd+w closes the active file tab; ctrl/cmd+pageup/down cycles file tabs.
  useHotkeys('ctrl+w, cmd+w', (e) => {
    if (selection.kind === 'file') {
      e.preventDefault();
      handleCloseFileTab(selection.tabId);
    }
  });
  const cycleFileTab = useCallback(
    (direction: 'next' | 'prev') => {
      if (tabs.length < 2 || selection.kind !== 'file') {
        return;
      }
      const currentIndex = tabs.findIndex((t) => t.id === selection.tabId);
      if (currentIndex === -1) {
        return;
      }
      const nextIndex =
        direction === 'next'
          ? (currentIndex + 1) % tabs.length
          : (currentIndex - 1 + tabs.length) % tabs.length;
      const next = tabs[nextIndex];
      if (next) {
        void handleSelectFileTab(next.id);
      }
    },
    [tabs, selection, handleSelectFileTab]
  );
  useHotkeys('ctrl+pageup, cmd+pageup', (e) => {
    e.preventDefault();
    cycleFileTab('prev');
  });
  useHotkeys('ctrl+pagedown, cmd+pagedown', (e) => {
    e.preventDefault();
    cycleFileTab('next');
  });

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      <WorkspaceTabStrip
        activeFileTabId={activeTabId}
        apps={apps}
        getTabStatusMessage={getStatusMessage}
        loadingFiles={loadingFiles}
        onCloseFileTab={handleCloseFileTab}
        onSelectApp={handleSelectApp}
        onSelectFileTab={handleSelectFileTab}
        selection={selection}
        tabStatuses={tabStatuses}
        tabs={tabs}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <WorkspaceBody
          apps={apps}
          fileContents={fileContents}
          isRestoring={isRestoring}
          loadingFiles={loadingFiles}
          onCloseAllFileTabs={tabs.length > 0 ? clearTabs : undefined}
          selection={selection}
          tabStatuses={tabStatuses}
          tabs={tabs}
        />
      </div>
    </div>
  );
});

WorkspaceTabHost.displayName = 'WorkspaceTabHost';

interface WorkspaceTabStripProps {
  readonly activeFileTabId: string | null;
  readonly apps: readonly WorkspaceApp[];
  readonly getTabStatusMessage: (compositeKey: string) => string | null;
  readonly loadingFiles: Set<string>;
  readonly onCloseFileTab: (tabId: string) => void;
  readonly onSelectApp: (appId: string) => void;
  readonly onSelectFileTab: (tabId: string) => void | Promise<void>;
  readonly selection: WorkspaceTabSelection;
  readonly tabStatuses: Map<string, TabFileStatus>;
  readonly tabs: FileTab[];
}

function WorkspaceTabStrip({
  apps,
  selection,
  onSelectApp,
  tabs,
  loadingFiles,
  tabStatuses,
  onSelectFileTab,
  onCloseFileTab,
  getTabStatusMessage,
}: WorkspaceTabStripProps) {
  return (
    <div
      className="flex flex-shrink-0 items-stretch border-border border-b bg-muted/30"
      role="tablist"
    >
      <div className="flex flex-shrink-0 items-stretch border-border border-r">
        {apps.map((app) => {
          const isActive = selection.kind === 'app' && selection.appId === app.id;
          return (
            <AppTabButton
              app={app}
              isActive={isActive}
              key={app.id}
              onSelect={() => onSelectApp(app.id)}
            />
          );
        })}
      </div>
      <div className="scrollbar-thin flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = selection.kind === 'file' && selection.tabId === tab.id;
          const status = tabStatuses.get(tab.compositeKey);
          const isLoading = loadingFiles.has(tab.compositeKey);
          const statusMessage = getTabStatusMessage(tab.compositeKey);
          return (
            <FileTabButton
              isActive={isActive}
              isLoading={isLoading}
              key={tab.id}
              onClose={() => onCloseFileTab(tab.id)}
              onSelect={() => {
                void onSelectFileTab(tab.id);
              }}
              status={status}
              statusMessage={statusMessage}
              tab={tab}
            />
          );
        })}
      </div>
    </div>
  );
}

interface AppTabButtonProps {
  readonly app: WorkspaceApp;
  readonly isActive: boolean;
  readonly onSelect: () => void;
}

function AppTabButton({ app, isActive, onSelect }: AppTabButtonProps) {
  const Icon = app.icon;
  return (
    <button
      aria-controls={`workspace-app-panel-${app.id}`}
      aria-selected={isActive}
      className={cn(
        'flex items-center gap-1.5 px-3 py-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isActive
          ? 'border-primary border-b-2 bg-background text-foreground'
          : 'border-transparent border-b-2 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      )}
      data-testid={`workspace-app-tab-${app.id}`}
      id={`workspace-app-tab-${app.id}`}
      onClick={onSelect}
      role="tab"
      type="button"
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="font-medium">{app.label}</span>
    </button>
  );
}

interface FileTabButtonProps {
  readonly isActive: boolean;
  readonly isLoading: boolean;
  readonly onClose: () => void;
  readonly onSelect: () => void;
  readonly status: TabFileStatus | undefined;
  readonly statusMessage: string | null;
  readonly tab: FileTab;
}

function FileTabButton({
  tab,
  isActive,
  isLoading,
  status,
  statusMessage,
  onSelect,
  onClose,
}: FileTabButtonProps) {
  const fileName = getFileName(tab.path);
  const tabButtonId = `workspace-file-tab-${tab.id}`;
  const panelId = `workspace-file-panel-${tab.id}`;
  return (
    <div
      className={cn(
        'flex flex-shrink-0 items-center border-transparent border-r border-b-2',
        isActive ? 'border-b-primary bg-background' : 'bg-muted/30 hover:bg-muted'
      )}
    >
      <button
        aria-controls={panelId}
        aria-selected={isActive}
        className={cn(
          'flex items-center gap-2 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          status?.status === 'needs-permission' && 'text-amber-600 dark:text-amber-400',
          status?.status === 'not-found' && 'text-destructive'
        )}
        data-testid={tabButtonId}
        id={tabButtonId}
        onClick={onSelect}
        role="tab"
        title={statusMessage ?? fileName}
        type="button"
      >
        <FileTabIcon isLoading={isLoading} status={status} />
        <span className="max-w-[16ch] truncate">{fileName}</span>
      </button>
      <Button
        aria-label={`Close ${fileName}`}
        className="mr-1 h-6 w-6 flex-shrink-0 rounded-sm"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        size="icon"
        title={`Close ${fileName}`}
        variant="ghost"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

interface FileTabIconProps {
  readonly isLoading: boolean;
  readonly status: TabFileStatus | undefined;
}

function FileTabIcon({ isLoading, status }: FileTabIconProps): ReactNode {
  if (isLoading) {
    return <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />;
  }
  if (status?.status === 'needs-permission') {
    return <LockKeyhole className="h-3 w-3 flex-shrink-0 text-amber-500" />;
  }
  if (status?.status === 'not-found') {
    return <AlertCircle className="h-3 w-3 flex-shrink-0 text-destructive" />;
  }
  return <File className="h-3 w-3 flex-shrink-0" />;
}

interface WorkspaceBodyProps {
  readonly apps: readonly WorkspaceApp[];
  readonly fileContents: { [key: string]: string };
  readonly isRestoring: boolean;
  readonly loadingFiles: Set<string>;
  readonly onCloseAllFileTabs: (() => void) | undefined;
  readonly selection: WorkspaceTabSelection;
  readonly tabStatuses: Map<string, TabFileStatus>;
  readonly tabs: FileTab[];
}

function WorkspaceBody({
  apps,
  selection,
  tabs,
  fileContents,
  loadingFiles,
  tabStatuses,
  isRestoring,
}: WorkspaceBodyProps) {
  if (selection.kind === 'app') {
    const app = apps.find((a) => a.id === selection.appId);
    if (!app) {
      return <MissingAppFallback appId={selection.appId} />;
    }
    return (
      <div
        aria-labelledby={`workspace-app-tab-${app.id}`}
        className="h-full"
        id={`workspace-app-panel-${app.id}`}
        role="tabpanel"
      >
        {app.render()}
      </div>
    );
  }

  const tab = tabs.find((t) => t.id === selection.tabId);
  if (!tab) {
    // Selected tab vanished (e.g. closed via cleanup). Render a friendly empty state.
    return <NoFileTabSelected />;
  }
  const status = tabStatuses.get(tab.compositeKey);
  const isLoading = loadingFiles.has(tab.compositeKey);
  const content = fileContents[tab.compositeKey];
  return (
    <div
      aria-labelledby={`workspace-file-tab-${tab.id}`}
      className="h-full"
      id={`workspace-file-panel-${tab.id}`}
      role="tabpanel"
    >
      <FileTabBody
        content={content}
        isLoading={isLoading}
        isRestoring={isRestoring}
        status={status}
        tab={tab}
      />
    </div>
  );
}

interface FileTabBodyProps {
  readonly content: string | undefined;
  readonly isLoading: boolean;
  readonly isRestoring: boolean;
  readonly status: TabFileStatus | undefined;
  readonly tab: FileTab;
}

function FileTabBody({ tab, content, isLoading, isRestoring, status }: FileTabBodyProps) {
  const path = useMemo(() => {
    try {
      return decodeFileSelection(tab.compositeKey).path;
    } catch {
      return tab.path;
    }
  }, [tab.compositeKey, tab.path]);

  const getScrollTop = useEditorViewStateStore((s) => s.getScrollTop);
  const setScrollTop = useEditorViewStateStore((s) => s.setScrollTop);
  const preRef = useRef<HTMLPreElement | null>(null);

  // biome-ignore lint/plugin: DOM scroll-restore effect — restores per-tab scroll offset on switch
  useEffect(() => {
    const el = preRef.current;
    if (el) {
      el.scrollTop = getScrollTop(tab.compositeKey);
    }
  }, [tab.compositeKey, getScrollTop]);

  const onScroll = useCallback(
    (e: React.UIEvent<HTMLPreElement>) => {
      setScrollTop(tab.compositeKey, e.currentTarget.scrollTop);
    },
    [setScrollTop, tab.compositeKey]
  );

  if (status?.status === 'needs-permission') {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div aria-live="polite" className="sr-only">
          File access required for {path}. Click the tab to restore access.
        </div>
        <LockKeyhole aria-hidden="true" className="mb-4 h-12 w-12 text-amber-500" />
        <p className="font-semibold text-lg">File Access Required</p>
        <p className="mt-2 max-w-md text-muted-foreground text-sm">
          Click the tab again to restore access to this file. Your browser requires permission to
          read files after a page reload.
        </p>
        {status.error ? <p className="mt-2 text-destructive text-xs">{status.error}</p> : null}
      </div>
    );
  }

  if (status?.status === 'not-found') {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div aria-live="polite" className="sr-only">
          File not found: {path}. This file may have been moved, renamed, or deleted.
        </div>
        <AlertCircle aria-hidden="true" className="mb-4 h-12 w-12 text-destructive" />
        <p className="font-semibold text-lg">File Not Found</p>
        <p className="mt-2 max-w-md text-muted-foreground text-sm">
          This file could not be restored. It may have been moved, renamed, or deleted.
        </p>
        <p className="mt-1 text-muted-foreground text-xs">{path}</p>
        {status.error ? <p className="mt-2 text-destructive text-xs">{status.error}</p> : null}
      </div>
    );
  }

  if (typeof content !== 'string') {
    // Three reasons content may be missing here, none of which is "the file is gone":
    //  1. Restoration is still in flight (status not yet emitted).
    //  2. We just opened the tab and loadFileContent hasn't completed.
    //  3. The active tab effect hasn't fired yet (e.g. fileTree not ready on web).
    // In all cases, "Restoring…" is the honest message — "File not found" was a lie.
    const isPending = isLoading || isRestoring || status?.status === 'pending';
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        <span>{isPending ? 'Restoring…' : 'Loading…'}</span>
      </div>
    );
  }

  const { text, truncated } = getDisplayContent(content);

  if (content.startsWith('File not accessible')) {
    return (
      <div className="h-full overflow-auto p-4">
        <p className="text-amber-600 dark:text-amber-400">{content}</p>
        <p className="mt-2 text-muted-foreground text-sm">
          To access this file, please open the folder again using the folder icon button. This is a
          security measure of your browser.
        </p>
      </div>
    );
  }

  return (
    <pre
      className="h-full overflow-auto whitespace-pre-wrap bg-muted/40 p-4 font-mono text-sm"
      data-truncated={truncated ? 'true' : 'false'}
      onScroll={onScroll}
      ref={preRef}
    >
      {text}
    </pre>
  );
}

function NoFileTabSelected() {
  return (
    <div className="flex h-full flex-col items-center justify-center p-4 text-center text-muted-foreground">
      <p className="font-semibold">No file selected</p>
      <p className="text-sm">Click on a file in the Explorer to open it here.</p>
    </div>
  );
}

interface MissingAppFallbackProps {
  readonly appId: string;
}

function MissingAppFallback({ appId }: MissingAppFallbackProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-4 text-center text-muted-foreground">
      <p className="font-semibold">App unavailable</p>
      <p className="text-sm">No registered workspace app matches "{appId}".</p>
    </div>
  );
}

function getFileName(path: string): string {
  const last = path.split('/').pop();
  return last && last.length > 0 ? last : path;
}

function getDisplayContent(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= MAX_DOM_CHARS) {
    return { text: raw, truncated: false };
  }
  const suffix = '\n\n… truncated for display …';
  return { text: raw.slice(0, MAX_DOM_CHARS - suffix.length) + suffix, truncated: true };
}
