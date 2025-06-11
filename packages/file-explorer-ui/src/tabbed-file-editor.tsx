import { Button, ScrollArea } from '@brainstrike/ui';
import { cn } from '@brainstrike/ui';
import { File, Loader2, X } from 'lucide-react';
import { memo, useEffect } from 'react';
import type { FileTab } from './hooks/use-tab-manager';

export interface TabbedFileEditorProps {
  tabs: FileTab[];
  activeTabId: string | null;
  fileContents: { [compositeKey: string]: string };
  loadingFiles: Set<string>;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onLoadFileContent: (compositeKey: string) => void;
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
}

export const TabbedFileEditor = memo<TabbedFileEditorProps>(function TabbedFileEditor({
  tabs,
  activeTabId,
  fileContents,
  loadingFiles,
  onTabClick,
  onTabClose,
  onLoadFileContent,
}) {
  // Load content for active tab if not already loaded
  useEffect(() => {
    if (activeTabId && !fileContents[activeTabId] && !loadingFiles.has(activeTabId)) {
      onLoadFileContent(activeTabId);
    }
  }, [activeTabId, fileContents, loadingFiles, onLoadFileContent]);

  const getFileName = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  };

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeContent = activeTabId ? fileContents[activeTabId] : null;
  const isActiveTabLoading = activeTabId ? loadingFiles.has(activeTabId) : false;

  if (tabs.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <File className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No files open</p>
          <p className="text-xs mt-1">Click on a file in the preview panel to open it here</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab Bar */}
      <div className="flex border-b border-border bg-muted/30">
        <div className="flex overflow-x-auto scrollbar-thin">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const fileName = getFileName(tab.path);
            const isLoading = loadingFiles.has(tab.id);

            return (
              <div
                key={tab.id}
                className={cn(
                  'flex items-center min-w-0 border-r border-border',
                  isActive ? 'bg-background' : 'bg-muted/30 hover:bg-muted/50'
                )}
              >
                <button
                  type="button"
                  onClick={() => onTabClick(tab.id)}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 text-sm min-w-0 flex-1',
                    'hover:bg-muted/30 transition-colors',
                    isActive && 'font-medium'
                  )}
                  title={tab.path}
                >
                  {isLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
                  ) : (
                    <File className="h-3 w-3 flex-shrink-0" />
                  )}
                  <span className="truncate">{fileName}</span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 flex-shrink-0 mr-1 hover:bg-destructive/20 hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                  title={`Close ${fileName}`}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden">
        {activeTab && (
          <div className="h-full flex flex-col">
            {/* File Path Header */}
            <div className="px-3 py-2 border-b border-border bg-muted/30">
              <div
                className="text-xs text-muted-foreground font-mono truncate"
                title={activeTab.path}
              >
                {activeTab.path}
              </div>
            </div>

            {/* File Content */}
            <ScrollArea className="flex-1">
              <div className="p-4">
                {isActiveTabLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading file content...
                  </div>
                ) : activeContent ? (
                  <pre className="whitespace-pre-wrap text-sm bg-muted p-3 rounded-md overflow-x-auto font-mono">
                    {activeContent.startsWith('File not accessible') ? (
                      <div className="text-amber-600 dark:text-amber-400">
                        <p>{activeContent}</p>
                        <p className="text-sm text-muted-foreground mt-2">
                          To access this file, please open the folder again using the folder
                          selection dialog.
                        </p>
                      </div>
                    ) : (
                      activeContent
                    )}
                  </pre>
                ) : (
                  <div className="text-muted-foreground">No content available</div>
                )}
              </div>
            </ScrollArea>
          </div>
        )}
      </div>
    </div>
  );
});

TabbedFileEditor.displayName = 'TabbedFileEditor';
