import type { FileToIndex } from '@brainstrike/token-cache/background-indexer';
import type {
  PlannedTokenIndexingElectronFile,
  PlannedTokenIndexingWebFile,
  TokenIndexingDispatchPlan,
} from './background-token-indexer-dispatch-planner';
import type { ElectronFileHandle, HandleInfo } from './background-token-indexer-handles';

export interface ElectronFileReadRequest {
  readonly compositeKey: string;
  readonly filePath: string;
  readonly fileSize: number | undefined;
  readonly folderId: string;
  readonly handle: ElectronFileHandle;
}

export interface PlannedTokenIndexingDispatchQueues {
  readonly electronFilesToRead: ElectronFileReadRequest[];
  readonly missingHandles: PlannedTokenIndexingMissingHandle[];
  readonly webFilesToIndex: FileToIndex[];
}

export interface PlannedTokenIndexingMissingHandle {
  readonly compositeKey: string;
  readonly dispatchKind: 'electron' | 'web';
}

interface PlannedWebFileResolution {
  readonly missingHandles: PlannedTokenIndexingMissingHandle[];
  readonly webFilesToIndex: FileToIndex[];
}

interface PlannedElectronFileResolution {
  readonly electronFilesToRead: ElectronFileReadRequest[];
  readonly missingHandles: PlannedTokenIndexingMissingHandle[];
}

export function resolvePlannedTokenIndexingHandles(params: {
  readonly dispatchPlan: Pick<TokenIndexingDispatchPlan, 'electronFiles' | 'webFiles'>;
  readonly handleInfoByCompositeKey: ReadonlyMap<string, HandleInfo>;
}): PlannedTokenIndexingDispatchQueues {
  const electronResolution = resolvePlannedElectronFiles({
    handleInfoByCompositeKey: params.handleInfoByCompositeKey,
    plannedFiles: params.dispatchPlan.electronFiles,
  });
  const webResolution = resolvePlannedWebFiles({
    handleInfoByCompositeKey: params.handleInfoByCompositeKey,
    plannedFiles: params.dispatchPlan.webFiles,
  });

  return {
    electronFilesToRead: electronResolution.electronFilesToRead,
    missingHandles: [...electronResolution.missingHandles, ...webResolution.missingHandles],
    webFilesToIndex: webResolution.webFilesToIndex,
  };
}

function resolvePlannedWebFiles(params: {
  readonly handleInfoByCompositeKey: ReadonlyMap<string, HandleInfo>;
  readonly plannedFiles: readonly PlannedTokenIndexingWebFile[];
}): PlannedWebFileResolution {
  const missingHandles: PlannedTokenIndexingMissingHandle[] = [];
  const webFilesToIndex: FileToIndex[] = [];

  for (const file of params.plannedFiles) {
    const handleInfo = params.handleInfoByCompositeKey.get(file.compositeKey);
    if (!handleInfo?.webHandle) {
      missingHandles.push({ compositeKey: file.compositeKey, dispatchKind: 'web' });
      continue;
    }

    webFilesToIndex.push({
      compositeKey: file.compositeKey,
      fileHandle: handleInfo.webHandle,
      filePath: file.filePath,
      folderId: file.folderId,
    });
  }

  return { missingHandles, webFilesToIndex };
}

function resolvePlannedElectronFiles(params: {
  readonly handleInfoByCompositeKey: ReadonlyMap<string, HandleInfo>;
  readonly plannedFiles: readonly PlannedTokenIndexingElectronFile[];
}): PlannedElectronFileResolution {
  const electronFilesToRead: ElectronFileReadRequest[] = [];
  const missingHandles: PlannedTokenIndexingMissingHandle[] = [];

  for (const file of params.plannedFiles) {
    const handleInfo = params.handleInfoByCompositeKey.get(file.compositeKey);
    if (!handleInfo?.electronHandle) {
      missingHandles.push({ compositeKey: file.compositeKey, dispatchKind: 'electron' });
      continue;
    }

    electronFilesToRead.push({
      compositeKey: file.compositeKey,
      filePath: file.filePath,
      fileSize: file.fileSize,
      folderId: file.folderId,
      handle: handleInfo.electronHandle,
    });
  }

  return { electronFilesToRead, missingHandles };
}
