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

declare global {
  interface Window {
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
