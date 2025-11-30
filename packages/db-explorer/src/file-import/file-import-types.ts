import type { FileImportRequest, FileImportResult, ImportProgress } from '@brainstrike/db';
import type { IFileNode } from '@brainstrike/types';

type BulkImportProgressHandler = (completed: number, total: number, current?: string) => void;

export type FileImportRepositoryPort = {
  readonly bulkImport?: (
    requests: FileImportRequest[],
    onProgress: BulkImportProgressHandler
  ) => Promise<FileImportResult[] | null>;
};

export type FileSystemPort = {
  readFile(node: IFileNode): Promise<string>;
};

export type FileImportDependencies = {
  readonly repository: FileImportRepositoryPort | null;
  readonly fileSystem: FileSystemPort | null;
};

export type FileImportContext = {
  readonly selectedFilePaths: Set<string>;
  readonly fileTree: IFileNode[];
  readonly fileContents: Record<string, string>;
  readonly embeddingSetId?: string; // Collection to associate files with
};

export type FileImportCallbacks = {
  readonly onProgress?: (progress: ImportProgress) => void;
};

export type FileImportOutcome = {
  readonly results: FileImportResult[];
  readonly progress: ImportProgress;
};
