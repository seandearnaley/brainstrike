import { Button, cn } from '@brainstrike/ui';
import { File, Loader2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import type { FileTab } from './hooks/use-tab-manager';

interface TabbedFileEditorProps {
  tabs: FileTab[];
  activeTabId: string | null;
  fileContents: { [compositeKey: string]: string };
  loadingFiles: Set<string>;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onLoadFileContent: (compositeKey: string) => void;
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
}

export function TabbedFileEditor({
  tabs,
  activeTabId,
  fileContents,
  loadingFiles,
  onTabClick,
  onTabClose,
  onLoadFileContent,
  decodeFileSelection,
}: TabbedFileEditorProps) {
  const activeTabRef = useRef<HTMLButtonElement>(null);

  // Load content for active tab if not already loaded
  useEffect(() => {
    if (activeTabId) {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      if (
        activeTab &&
        !fileContents[activeTab.compositeKey] &&
        !loadingFiles.has(activeTab.compositeKey)
      ) {
        onLoadFileContent(activeTab.compositeKey);
      }
    }
  }, [activeTabId, tabs, fileContents, loadingFiles, onLoadFileContent]);

  // Scroll active tab into view
  // biome-ignore lint/correctness/useExhaustiveDependencies: The ref's current element changes with activeTabId
  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [activeTabId]);

  const getFileName = (path: string) => path.split('/').pop() || path;

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeContent = activeTab ? fileContents[activeTab.compositeKey] : null;
  const activeIsLoading = activeTab ? loadingFiles.has(activeTab.compositeKey) : false;
  const activePath = activeTab ? decodeFileSelection(activeTab.compositeKey).path : '';

  // Hotkeys for tab management
  useHotkeys('ctrl+w, cmd+w', (e) => {
    e.preventDefault();
    if (activeTabId) {
      onTabClose(activeTabId);
    }
  });

  const cycleTab = (direction: 'next' | 'prev') => {
    if (!activeTabId || tabs.length < 2) return;
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    if (currentIndex === -1) return;

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
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 border-b border-border overflow-x-auto" role="tablist">
        <div className="flex overflow-x-auto scrollbar-thin">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const { path } = decodeFileSelection(tab.compositeKey);
            const fileName = getFileName(path);

            return (
              <div
                key={tab.id}
                role="presentation"
                className={cn(
                  'flex-shrink-0 border-r border-transparent',
                  isActive ? 'border-border' : ''
                )}
              >
                <div
                  className={cn(
                    'flex items-center',
                    isActive ? 'bg-background' : 'bg-muted/50 hover:bg-muted'
                  )}
                >
                  <button
                    ref={isActive ? activeTabRef : null}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className="flex items-center gap-2 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onTabClick(tab.id)}
                  >
                    {loadingFiles.has(tab.compositeKey) ? (
                      <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
                    ) : (
                      <File className="h-3 w-3 flex-shrink-0" />
                    )}
                    <span className="truncate">{fileName}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 rounded-sm flex-shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTabClose(tab.id);
                    }}
                    title={`Close ${fileName}`}
                    aria-label={`Close ${fileName}`}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-background" role="tabpanel">
        {tabs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4 text-center">
            <p className="font-semibold">No files open</p>
            <p className="text-sm">Click on a file in the preview panel to open it here</p>
          </div>
        ) : (
          <div className="p-4">
            {activeIsLoading ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Loading file content...
              </div>
            ) : activeContent ? (
              <pre className="whitespace-pre-wrap text-sm bg-muted p-3 rounded-md overflow-x-auto font-mono">
                {activeContent.startsWith('File not accessible') ? (
                  <div className="text-amber-600 dark:text-amber-400">
                    <p>{activeContent}</p>
                    <p className="text-sm text-muted-foreground mt-2">
                      To access this file, please open the folder again using the folder icon
                      button. This is a security measure of your browser.
                    </p>
                  </div>
                ) : (
                  activeContent
                )}
              </pre>
            ) : activeTabId ? (
              <div className="text-muted-foreground">
                File not found or unable to load: {activePath}
              </div>
            ) : (
              <div className="text-muted-foreground">Select a file to view its content.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
