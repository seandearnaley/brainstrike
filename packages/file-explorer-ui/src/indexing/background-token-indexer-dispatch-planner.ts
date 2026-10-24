import { DEFAULT_MAX_FILE_SIZE } from '@brainstrike/file-system';
import { isBinaryFile } from '@brainstrike/utils/file-utils';

export type TokenIndexingDispatchHandleKind = 'electron' | 'web';

export interface TokenIndexingDispatchHandle {
  readonly fileName: string;
  readonly fileSize: number | undefined;
  readonly kind: TokenIndexingDispatchHandleKind;
  readonly synthetic: boolean;
}

export interface TokenIndexingFileCandidate {
  readonly compositeKey: string;
  readonly folderId: string;
  readonly handle: TokenIndexingDispatchHandle | null;
  readonly kind: 'file';
  readonly normalizedFilePath: string;
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
}

export interface PlanTokenIndexingDispatchParams {
  readonly candidates: readonly TokenIndexingDispatchCandidate[];
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
      builder.skipped.noHandle += 1;
      builder.pendingNoHandleKeysToAdd.push(candidate.compositeKey);
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
