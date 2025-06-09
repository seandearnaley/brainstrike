import { Button, ScrollArea } from '@brainstrike/ui';
import { FileX2, Loader2 } from 'lucide-react';
import { memo } from 'react';

export interface FileDetailPanelProps {
  compositeKey: string;
  fileContents: { [compositeKey: string]: string };
  loadingFiles: Set<string>;
  onClose: () => void;
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
}

export const FileDetailPanel = memo<FileDetailPanelProps>(function FileDetailPanel({
  compositeKey,
  fileContents,
  loadingFiles,
  onClose,
  decodeFileSelection,
}) {
  const { path } = decodeFileSelection(compositeKey);
  const content = fileContents[compositeKey];
  const isLoading = loadingFiles.has(compositeKey);

  return (
    <div className="w-96 border-l border-border flex flex-col bg-background">
      <div className="p-3 border-b flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium truncate" title={path}>
            {path}
          </h3>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="flex-shrink-0"
          title="Close file detail panel"
        >
          <FileX2 className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading...
            </div>
          ) : content ? (
            <pre className="whitespace-pre-wrap text-sm bg-muted p-3 rounded-md overflow-x-auto">
              {content.startsWith('File not accessible') ? (
                <div className="text-amber-600 dark:text-amber-400">
                  <p>{content}</p>
                  <p className="text-sm text-muted-foreground mt-2">
                    To access this file, please open the folder again using the folder selection
                    dialog.
                  </p>
                </div>
              ) : (
                content
              )}
            </pre>
          ) : (
            <div className="text-muted-foreground">No content available</div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
});

FileDetailPanel.displayName = 'FileDetailPanel';

export default FileDetailPanel;
