'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Folder } from 'lucide-react';
import type React from 'react';
import { useMemo } from 'react';
import OramaSearchPanel from './orama-search-panel';
import { PreviewPanel } from './preview-panel';

interface FileExplorerMainPanelProps {
  rootDirectoryHandle: FileSystemDirectoryHandle | null;
  selectedFiles: Set<string>;
  fileContents: Record<string, string>;
  loadingFiles: Set<string>;
  onSelectionChange: (selectedFiles: Set<string>) => void;
}

export const FileExplorerMainPanel: React.FC<FileExplorerMainPanelProps> = ({
  rootDirectoryHandle,
  selectedFiles,
  fileContents,
  loadingFiles,
  onSelectionChange,
}) => {
  // Calculate file sizes from file contents
  const fileSizes = useMemo(() => {
    const sizes: Record<string, number> = {};

    for (const [compositeKey, content] of Object.entries(fileContents)) {
      // Use TextEncoder to get byte length of the content
      sizes[compositeKey] = new TextEncoder().encode(content).length;
    }

    return sizes;
  }, [fileContents]);

  if (!rootDirectoryHandle) {
    return (
      <div className="h-full flex items-center justify-center border-2 border-dashed rounded-lg p-4">
        <div className="text-center text-muted-foreground">
          <Folder className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>Select a root directory to view file details and Git information</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Tabs defaultValue="preview" className="h-full flex flex-col">
        <TabsList className="flex shrink-0">
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="search">Search</TabsTrigger>
        </TabsList>
        <TabsContent value="preview" className="flex-1 overflow-hidden">
          <PreviewPanel
            selectedFiles={selectedFiles}
            fileContents={fileContents}
            loadingFiles={loadingFiles}
            onSelectionChange={onSelectionChange}
            fileSizes={fileSizes}
          />
        </TabsContent>
        <TabsContent value="search" className="flex-1 overflow-hidden">
          <OramaSearchPanel selectedFiles={selectedFiles} fileContents={fileContents} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default FileExplorerMainPanel;
