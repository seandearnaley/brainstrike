import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { AlertCircle, File, Loader2, LockKeyhole, MoreHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import type { FileTab } from './hooks/use-tab-manager';
import { useEditorViewStateStore } from './stores/editor-view-state-store';

export interface TabStripAction {
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcutHint?: string;
  enabled?: boolean;
  visible?: boolean;
  onSelect: () => void;
}

interface TabbedFileEditorProps {
  tabs: FileTab[];
  activeTabId: string | null;
  fileContents: { [compositeKey: string]: string };
  loadingFiles: Set<string>;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onLoadFileContent: (compositeKey: string) => void;
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
  tabStripActions?: TabStripAction[];
  /** BST-307: Map of composite key to restoration status for persisted tabs */
  tabStatuses?: Map<string, TabFileStatus>;
  /** BST-307: Get status message for a tab (used for tooltips) */
  getTabStatusMessage?: (compositeKey: string) => string | null;
}

/** Get the appropriate icon for a tab based on its status */
function getTabIcon(isLoading: boolean, tabStatus: TabFileStatus | undefined): React.ReactNode {
  if (isLoading) {
    return <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />;
  }

  if (tabStatus) {
    switch (tabStatus.status) {
      case 'needs-permission':
        return <LockKeyhole className="h-3 w-3 flex-shrink-0 text-amber-500" />;
      case 'not-found':
        return <AlertCircle className="h-3 w-3 flex-shrink-0 text-destructive" />;
    }
  }

  return <File className="h-3 w-3 flex-shrink-0" />;
}

interface TabContentNodeProps {
  isLoading: boolean;
  content: string | undefined;
  isActive: boolean;
  tab: FileTab;
  path: string;
  text: string | undefined;
  truncated: boolean;
  /** Callback with the pre element when active, null when inactive */
  onActiveElement: (el: HTMLPreElement | null) => void;
  handleContentScroll: (compositeKey: string, e: React.UIEvent<HTMLPreElement>) => void;
  tabStatus: TabFileStatus | undefined;
}

function TabContentNode({
  isLoading,
  content,
  isActive,
  tab,
  path,
  text,
  truncated,
  onActiveElement,
  handleContentScroll,
  tabStatus,
}: TabContentNodeProps) {
  // BST-307: Show permission prompt for tabs needing permission
  if (tabStatus?.status === 'needs-permission') {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        {/* ARIA live region for screen readers */}
        <div aria-live="polite" className="sr-only">
          File access required for {path}. Click the tab to restore access.
        </div>
        <LockKeyhole aria-hidden="true" className="mb-4 h-12 w-12 text-amber-500" />
        <p className="font-semibold text-lg">File Access Required</p>
        <p className="mt-2 max-w-md text-muted-foreground text-sm">
          Click the tab again to restore access to this file. Your browser requires permission to
          read files after a page reload.
        </p>
        {tabStatus.error ? (
          <p className="mt-2 text-destructive text-xs">{tabStatus.error}</p>
        ) : null}
      </div>
    );
  }

  // BST-307: Show not-found message for tabs whose files are missing
  if (tabStatus?.status === 'not-found') {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        {/* ARIA live region for screen readers */}
        <div aria-live="polite" className="sr-only">
          File not found: {path}. This file may have been moved, renamed, or deleted.
        </div>
        <AlertCircle aria-hidden="true" className="mb-4 h-12 w-12 text-destructive" />
        <p className="font-semibold text-lg">File Not Found</p>
        <p className="mt-2 max-w-md text-muted-foreground text-sm">
          This file could not be restored. It may have been moved, renamed, or deleted.
        </p>
        <p className="mt-1 text-muted-foreground text-xs">{path}</p>
        {tabStatus.error ? (
          <p className="mt-2 text-destructive text-xs">{tabStatus.error}</p>
        ) : null}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading file content...
      </div>
    );
  }
  if (!content) {
    return <div className="text-muted-foreground">File not found or unable to load: {path}</div>;
  }
  return (
    <pre
      className="h-full overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-sm"
      data-truncated={truncated ? 'true' : 'false'}
      onScroll={(e) => handleContentScroll(tab.compositeKey, e)}
      ref={isActive ? onActiveElement : null}
    >
      {content.startsWith('File not accessible') ? (
        <div className="text-amber-600 dark:text-amber-400">
          <p>{content}</p>
          <p className="mt-2 text-muted-foreground text-sm">
            To access this file, please open the folder again using the folder icon button. This is
            a security measure of your browser.
          </p>
        </div>
      ) : (
        text
      )}
    </pre>
  );
}

interface TabStripOverflowMenuProps {
  actions: TabStripAction[];
}

function TabStripOverflowMenu({ actions }: TabStripOverflowMenuProps) {
  const visibleActions = actions.filter((action) => action.visible !== false);

  return (
    <DropdownMenu>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="More actions"
                className="h-7 w-7 rounded-sm"
                size="icon"
                title="More actions"
                variant="ghost"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More actions</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end" side="bottom" sideOffset={6}>
        {visibleActions.map((action) => {
          const isEnabled = action.enabled ?? true;
          return (
            <DropdownMenuItem
              disabled={!isEnabled}
              key={action.id}
              onSelect={() => {
                if (isEnabled) {
                  action.onSelect();
                }
              }}
            >
              {action.icon ? (
                <span aria-hidden className="text-muted-foreground">
                  {action.icon}
                </span>
              ) : null}
              <span>{action.label}</span>
              {action.shortcutHint ? (
                <DropdownMenuShortcut>{action.shortcutHint}</DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const EMPTY_TAB_STRIP_ACTIONS: TabStripAction[] = [];

export function TabbedFileEditor({
  tabs,
  activeTabId,
  fileContents,
  loadingFiles,
  onTabClick,
  onTabClose,
  onLoadFileContent,
  decodeFileSelection,
  tabStripActions = EMPTY_TAB_STRIP_ACTIONS,
  tabStatuses,
  getTabStatusMessage,
}: TabbedFileEditorProps) {
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const activeContentRef = useRef<HTMLPreElement | null>(null);
  const getScrollTop = useEditorViewStateStore((s) => s.getScrollTop);
  const setScrollTop = useEditorViewStateStore((s) => s.setScrollTop);

  // Callback ref that TabContentNode calls to register/unregister the active pre element.
  const handleActiveElement = useCallback((el: HTMLPreElement | null) => {
    activeContentRef.current = el;
  }, []);

  // Load content for active tab if not already loaded
  // biome-ignore lint/plugin: Load content for active tab - reactive data loading
  useEffect(() => {
    if (activeTabId) {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      if (
        activeTab &&
        !fileContents[activeTab.compositeKey] &&
        !loadingFiles.has(activeTab.compositeKey)
      ) {
        // BST-307: Don't auto-load if tab needs permission (will be handled by click)
        const tabStatus = tabStatuses?.get(activeTab.compositeKey);
        if (!tabStatus || tabStatus.status === 'restored') {
          onLoadFileContent(activeTab.compositeKey);
        }
      }
    }
  }, [activeTabId, tabs, fileContents, loadingFiles, onLoadFileContent, tabStatuses]);

  // Scroll active tab into view
  // biome-ignore lint/plugin: DOM scroll effect - runs once on mount
  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, []);

  // Restore scroll position for active tab content
  useEffect(() => {
    if (!activeTabId) {
      return;
    }
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab) {
      return;
    }
    const el = activeContentRef.current;
    if (el) {
      el.scrollTop = getScrollTop(activeTab.compositeKey);
    }
  }, [activeTabId, tabs, getScrollTop]);

  const handleContentScroll = useCallback(
    (compositeKey: string, e: React.UIEvent<HTMLPreElement>) => {
      setScrollTop(compositeKey, (e.currentTarget as HTMLPreElement).scrollTop);
    },
    [setScrollTop]
  );

  const MaxDomChars = 200_000; // ~200KB of visible text per panel

  const getDisplayContent = (raw?: string) => {
    if (!raw) {
      return { text: raw, truncated: false } as const;
    }
    if (raw.length <= MaxDomChars) {
      return { text: raw, truncated: false } as const;
    }
    const suffix = '\n\n… truncated for display …';
    return { text: raw.slice(0, MaxDomChars - suffix.length) + suffix, truncated: true } as const;
  };

  const renderTabPanel = useCallback(
    (
      tab: FileTab,
      isActive: boolean,
      content: string | undefined,
      isLoading: boolean,
      path: string,
      tabStatus: TabFileStatus | undefined
    ) => {
      const panelId = `panel-${tab.id}`;
      const tabButtonId = `tab-${tab.id}`;
      const { text, truncated } = getDisplayContent(content);

      return (
        <div
          aria-labelledby={tabButtonId}
          className="h-full p-4"
          hidden={!isActive}
          id={panelId}
          key={tab.id}
          role="tabpanel"
        >
          <TabContentNode
            content={content}
            handleContentScroll={handleContentScroll}
            isActive={isActive}
            isLoading={isLoading}
            onActiveElement={handleActiveElement}
            path={path}
            tab={tab}
            tabStatus={tabStatus}
            text={text}
            truncated={truncated}
          />
        </div>
      );
    },
    [handleContentScroll, handleActiveElement]
  );

  const getFileName = (path: string) => path.split('/').pop() || path;

  // Hotkeys for tab management
  useHotkeys('ctrl+w, cmd+w', (e) => {
    e.preventDefault();
    if (activeTabId) {
      onTabClose(activeTabId);
    }
  });

  const cycleTab = (direction: 'next' | 'prev') => {
    if (!activeTabId || tabs.length < 2) {
      return;
    }
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    if (currentIndex === -1) {
      return;
    }

    let nextIndex: number;
    if (direction === 'next') {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    }
    const nextTab = tabs[nextIndex];
    if (nextTab) {
      onTabClick(nextTab.id);
    }
  };

  useHotkeys('ctrl+pageup, cmd+pageup', (e) => {
    e.preventDefault();
    cycleTab('prev');
  });

  useHotkeys('ctrl+pagedown, cmd+pagedown', (e) => {
    e.preventDefault();
    cycleTab('next');
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 border-border border-b">
        <div className="flex items-stretch">
          <div className="scrollbar-thin flex min-w-0 flex-1 overflow-x-auto" role="tablist">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const { path } = decodeFileSelection(tab.compositeKey);
              const fileName = getFileName(path);
              const tabButtonId = `tab-${tab.id}`;
              const panelId = `panel-${tab.id}`;
              const tabStatus = tabStatuses?.get(tab.compositeKey);
              const statusMessage = getTabStatusMessage?.(tab.compositeKey);
              const isLoading = loadingFiles.has(tab.compositeKey);

              const tabButton = (
                <button
                  aria-controls={panelId}
                  aria-selected={isActive}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    tabStatus?.status === 'needs-permission' &&
                      'text-amber-600 dark:text-amber-400',
                    tabStatus?.status === 'not-found' && 'text-destructive'
                  )}
                  id={tabButtonId}
                  onClick={() => onTabClick(tab.id)}
                  ref={isActive ? activeTabRef : null}
                  role="tab"
                  type="button"
                >
                  {getTabIcon(isLoading, tabStatus)}
                  <span className="truncate">{fileName}</span>
                </button>
              );

              return (
                <div
                  className={cn(
                    'flex-shrink-0 border-transparent border-r',
                    isActive ? 'border-border' : ''
                  )}
                  key={tab.id}
                  role="presentation"
                >
                  <div
                    className={cn(
                      'flex items-center',
                      isActive ? 'bg-background' : 'bg-muted/50 hover:bg-muted'
                    )}
                  >
                    {statusMessage ? (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>{tabButton}</TooltipTrigger>
                          <TooltipContent side="bottom">{statusMessage}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      tabButton
                    )}
                    <Button
                      aria-label={`Close ${fileName}`}
                      className="h-6 w-6 flex-shrink-0 rounded-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTabClose(tab.id);
                      }}
                      size="icon"
                      title={`Close ${fileName}`}
                      variant="ghost"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center border-border border-l px-1">
            <TabStripOverflowMenu actions={tabStripActions} />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-background">
        {tabs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-4 text-center text-muted-foreground">
            <p className="font-semibold">No files open</p>
            <p className="text-sm">Click on a file in Context Explorer to open it here</p>
          </div>
        ) : activeTabId === null ? (
          <div className="p-4 text-muted-foreground">Select a file to view its content.</div>
        ) : (
          tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const content = fileContents[tab.compositeKey];
            const isLoading = loadingFiles.has(tab.compositeKey);
            const { path } = decodeFileSelection(tab.compositeKey);
            const tabStatus = tabStatuses?.get(tab.compositeKey);
            return renderTabPanel(tab, isActive, content, isLoading, path, tabStatus);
          })
        )}
      </div>
    </div>
  );
}
