export {};

interface FileExplorerTestSnapshot {
  currentFolderId: string | null;
  materializedPathCount: number;
  materializedPathSamples: string[];
  rootDirectoryPath: string | null;
  selectedFilePathCount: number;
  selectedFilePathSamples: string[];
  selectionMode: 'explicit' | 'query';
  treeRootCount: number;
  treeSamples: Array<{
    childCount: number;
    path: string;
    rootFolderId: string | null;
    type: string;
  }>;
}

interface ContextExplorerPreviewTestSnapshot {
  activeTab: string;
  renderedFilePaths: string[];
  selectedFilesCount: number;
  totalRows: number;
}

declare global {
  interface Window {
    __brainstrikeContextExplorerPreviewTestHooks__?:
      | {
          getSnapshot: () => ContextExplorerPreviewTestSnapshot;
        }
      | undefined;
    __brainstrikeFileExplorerTestHooks__?:
      | {
          getSnapshot: () => FileExplorerTestSnapshot;
        }
      | undefined;
    desktopLifecycle?: {
      isTestMode?: boolean;
    };
  }
}
