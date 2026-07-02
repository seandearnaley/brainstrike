import type {
  ApplyManagedCacheBatchArgs,
  FileImportRequest,
  FileImportResult,
  ImportProgress,
} from '@brainstrike/db';
import type { IFileNode } from '@brainstrike/types';

type BulkImportProgressHandler = (completed: number, total: number, current?: string) => void;

export interface FileImportRepositoryPort {
  readonly bulkImport?: (
    requests: FileImportRequest[],
    onProgress: BulkImportProgressHandler
  ) => Promise<FileImportResult[] | null>;
}

export interface ManagedCacheImportPort {
  readonly applyBatch: (args: ApplyManagedCacheBatchArgs) => Promise<void>;
  readonly findExistingByIdentity: (args: {
    readonly embeddingSetId: string;
    readonly relativePaths: readonly string[];
    readonly rootId: string;
  }) => Promise<readonly { readonly id: string; readonly path: string }[]>;
}

export interface FileSystemPort {
  readFile(node: IFileNode): Promise<string>;
  readFileBySelection?(
    folderId: string,
    path: string
  ): Promise<{
    content: string;
    mtimeMs?: number | null;
    name: string;
    path: string;
    size: number;
  } | null>;
}

export interface FileImportDependencies {
  readonly fileSystem: FileSystemPort | null;
  readonly managedCacheImport?: ManagedCacheImportPort | null;
  readonly repository: FileImportRepositoryPort | null;
}

export interface FileImportContext {
  readonly embeddingSetId?: string; // Collection to associate files with
  readonly fileContents: Record<string, string>;
  readonly fileTree: IFileNode[];
  readonly selectedFilePaths: Set<string>;
}

export interface FileImportCallbacks {
  readonly onProgress?: (progress: ImportProgress) => void;
}

export interface FileImportOutcome {
  readonly progress: ImportProgress;
  readonly results: FileImportResult[];
}
