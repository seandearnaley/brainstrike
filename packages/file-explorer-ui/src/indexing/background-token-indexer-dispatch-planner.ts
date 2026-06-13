import { DEFAULT_MAX_FILE_SIZE } from '@brainstrike/file-system';
import { isBinaryFile } from '@brainstrike/utils/file-utils';
import { getSlashPathFileName } from './background-token-indexer-handles';

export type TokenIndexingDispatchHandleKind = 'electron' | 'web';

export interface TokenIndexingDispatchHandle {
  readonly fileName: string;
  readonly fileSize: number | undefined;
  readonly kind: TokenIndexingDispatchHandleKind;
  readonly synthetic: boolean;
}

export interface TokenIndexingFileCandidate {
  readonly cachedFileSize?: number;
  readonly compositeKey: string;
  readonly folderId: string;
  readonly handle: TokenIndexingDispatchHandle | null;
  readonly kind: 'file';
  readonly normalizedFilePath: string;
  readonly resolverFileName?: string;
  readonly selectionPath: string;
}

export interface TokenIndexingInvalidPathCandidate {
  readonly compositeKey: string;
  readonly errorMessage: string;
  readonly folderId: string;
  readonly kind: 'invalid-path';
  readonly selectionPath: string;
}

export type TokenIndexingDispatchCandidate =
  | TokenIndexingFileCandidate
  | TokenIndexingInvalidPathCandidate;

export interface PlannedTokenIndexingWebFile {
  readonly compositeKey: string;
  readonly filePath: string;
  readonly folderId: string;
}

export interface PlannedTokenIndexingElectronFile {
  readonly compositeKey: string;
  readonly filePath: string;
  readonly fileSize: number | undefined;
  readonly folderId: string;
}

export interface PlannedTokenIndexingWebResolverFile {
  readonly absolutePath: string;
  readonly compositeKey: string;
  readonly filePath: string;
  readonly folderId: string;
}

export interface TokenIndexingDispatchSkippedCounts {
  readonly binary: number;
  readonly invalidPath: number;
  readonly noHandle: number;
  readonly tooLarge: number;
}

export interface TokenIndexingInvalidPathWarning {
  readonly compositeKey: string;
  readonly errorMessage: string;
  readonly folderId: string;
  readonly selectionPath: string;
}

export interface TokenIndexingDispatchPlan {
  readonly electronFiles: readonly PlannedTokenIndexingElectronFile[];
  readonly estimatedElectronBytes: number;
  readonly indexedKeysToAdd: readonly string[];
  readonly invalidPathWarnings: readonly TokenIndexingInvalidPathWarning[];
  readonly pendingNoHandleKeysToAdd: readonly string[];
  readonly pendingNoHandleKeysToDelete: readonly string[];
  readonly skipped: TokenIndexingDispatchSkippedCounts;
  readonly webFiles: readonly PlannedTokenIndexingWebFile[];
  readonly webResolverFiles: readonly PlannedTokenIndexingWebResolverFile[];
}

export interface PlanTokenIndexingDispatchParams {
  readonly candidates: readonly TokenIndexingDispatchCandidate[];
  readonly hasWebFileHandleResolver?: boolean;
  readonly indexedKeys: ReadonlySet<string>;
  readonly inFlightKeys: ReadonlySet<string>;
  readonly maxIndexableFileSize?: number;
}

export function planTokenIndexingDispatch(
  params: PlanTokenIndexingDispatchParams
): TokenIndexingDispatchPlan {
  const maxIndexableFileSize = params.maxIndexableFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const builder = createDispatchPlanBuilder();

  for (const candidate of params.candidates) {
    if (
      params.indexedKeys.has(candidate.compositeKey) ||
      params.inFlightKeys.has(candidate.compositeKey)
    ) {
      continue;
    }

    if (candidate.kind === 'invalid-path') {
      builder.skipped.invalidPath += 1;
      builder.invalidPathWarnings.push({
        compositeKey: candidate.compositeKey,
        errorMessage: candidate.errorMessage,
        folderId: candidate.folderId,
        selectionPath: candidate.selectionPath,
      });
      continue;
    }

    if (!candidate.handle) {
      planMissingHandleCandidate({
        builder,
        candidate,
        hasWebFileHandleResolver: params.hasWebFileHandleResolver === true,
        maxIndexableFileSize,
      });
      continue;
    }

    planResolvedHandleCandidate({
      builder,
      candidate,
      maxIndexableFileSize,
    });
  }

  return {
    electronFiles: builder.electronFiles,
    estimatedElectronBytes: builder.estimatedElectronBytes,
    indexedKeysToAdd: builder.indexedKeysToAdd,
    invalidPathWarnings: builder.invalidPathWarnings,
    pendingNoHandleKeysToAdd: builder.pendingNoHandleKeysToAdd,
    pendingNoHandleKeysToDelete: builder.pendingNoHandleKeysToDelete,
    skipped: builder.skipped,
    webFiles: builder.webFiles,
    webResolverFiles: builder.webResolverFiles,
  };
}

interface DispatchPlanBuilder {
  readonly electronFiles: PlannedTokenIndexingElectronFile[];
  estimatedElectronBytes: number;
  readonly indexedKeysToAdd: string[];
  readonly invalidPathWarnings: TokenIndexingInvalidPathWarning[];
  readonly pendingNoHandleKeysToAdd: string[];
  readonly pendingNoHandleKeysToDelete: string[];
  readonly skipped: {
    binary: number;
    invalidPath: number;
    noHandle: number;
    tooLarge: number;
  };
  readonly webFiles: PlannedTokenIndexingWebFile[];
  readonly webResolverFiles: PlannedTokenIndexingWebResolverFile[];
}

function createDispatchPlanBuilder(): DispatchPlanBuilder {
  return {
    electronFiles: [],
    estimatedElectronBytes: 0,
    indexedKeysToAdd: [],
    invalidPathWarnings: [],
    pendingNoHandleKeysToAdd: [],
    pendingNoHandleKeysToDelete: [],
    skipped: {
      binary: 0,
      invalidPath: 0,
      noHandle: 0,
      tooLarge: 0,
    },
    webFiles: [],
    webResolverFiles: [],
  };
}

function planResolvedHandleCandidate(params: {
  builder: DispatchPlanBuilder;
  candidate: TokenIndexingFileCandidate;
  maxIndexableFileSize: number;
}): void {
  const { builder, candidate, maxIndexableFileSize } = params;
  const { handle } = candidate;
  if (!handle) {
    return;
  }

  builder.pendingNoHandleKeysToDelete.push(candidate.compositeKey);

  if (isBinaryFile(handle.fileName)) {
    builder.skipped.binary += 1;
    builder.indexedKeysToAdd.push(candidate.compositeKey);
    return;
  }

  if (handle.fileSize !== undefined && handle.fileSize > maxIndexableFileSize) {
    builder.skipped.tooLarge += 1;
    if (handle.synthetic) {
      builder.pendingNoHandleKeysToAdd.push(candidate.compositeKey);
      return;
    }
    builder.indexedKeysToAdd.push(candidate.compositeKey);
    return;
  }

  if (handle.kind === 'web') {
    builder.webFiles.push({
      compositeKey: candidate.compositeKey,
      filePath: candidate.normalizedFilePath,
      folderId: candidate.folderId,
    });
    return;
  }

  builder.estimatedElectronBytes += handle.fileSize ?? 0;
  builder.electronFiles.push({
    compositeKey: candidate.compositeKey,
    filePath: candidate.normalizedFilePath,
    fileSize: handle.fileSize,
    folderId: candidate.folderId,
  });
}

function planMissingHandleCandidate(params: {
  builder: DispatchPlanBuilder;
  candidate: TokenIndexingFileCandidate;
  hasWebFileHandleResolver: boolean;
  maxIndexableFileSize: number;
}): void {
  const { builder, candidate, hasWebFileHandleResolver, maxIndexableFileSize } = params;
  if (!hasWebFileHandleResolver) {
    builder.skipped.noHandle += 1;
    builder.pendingNoHandleKeysToAdd.push(candidate.compositeKey);
    return;
  }

  const resolverFileName =
    candidate.resolverFileName ?? getSlashPathFileName(candidate.normalizedFilePath);
  if (isBinaryFile(resolverFileName)) {
    builder.skipped.binary += 1;
    builder.indexedKeysToAdd.push(candidate.compositeKey);
    builder.pendingNoHandleKeysToDelete.push(candidate.compositeKey);
    return;
  }

  if (candidate.cachedFileSize !== undefined && candidate.cachedFileSize > maxIndexableFileSize) {
    builder.skipped.tooLarge += 1;
    builder.pendingNoHandleKeysToAdd.push(candidate.compositeKey);
    return;
  }

  builder.webResolverFiles.push({
    absolutePath: buildWebResolverPath(candidate.folderId, candidate.normalizedFilePath),
    compositeKey: candidate.compositeKey,
    filePath: candidate.normalizedFilePath,
    folderId: candidate.folderId,
  });
  builder.pendingNoHandleKeysToDelete.push(candidate.compositeKey);
}

function buildWebResolverPath(folderId: string, normalizedFilePath: string): string {
  if (normalizedFilePath.startsWith(`${folderId}/`)) {
    return normalizedFilePath;
  }
  return `${folderId}/${normalizedFilePath}`;
}
