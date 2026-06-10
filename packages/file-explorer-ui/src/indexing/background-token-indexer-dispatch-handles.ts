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
  readonly webFilesToIndex: FileToIndex[];
}

export function resolvePlannedTokenIndexingHandles(params: {
  readonly dispatchPlan: Pick<TokenIndexingDispatchPlan, 'electronFiles' | 'webFiles'>;
  readonly handleInfoByCompositeKey: ReadonlyMap<string, HandleInfo>;
}): PlannedTokenIndexingDispatchQueues {
  return {
    electronFilesToRead: resolvePlannedElectronFiles({
      handleInfoByCompositeKey: params.handleInfoByCompositeKey,
      plannedFiles: params.dispatchPlan.electronFiles,
    }),
    webFilesToIndex: resolvePlannedWebFiles({
      handleInfoByCompositeKey: params.handleInfoByCompositeKey,
      plannedFiles: params.dispatchPlan.webFiles,
    }),
  };
}

function resolvePlannedWebFiles(params: {
  readonly handleInfoByCompositeKey: ReadonlyMap<string, HandleInfo>;
  readonly plannedFiles: readonly PlannedTokenIndexingWebFile[];
}): FileToIndex[] {
  return params.plannedFiles.map((file) => {
    const handleInfo = params.handleInfoByCompositeKey.get(file.compositeKey);
    if (!handleInfo?.webHandle) {
      throw new Error(`Missing planned web file handle for ${file.compositeKey}`);
    }

    return {
      compositeKey: file.compositeKey,
      fileHandle: handleInfo.webHandle,
      filePath: file.filePath,
      folderId: file.folderId,
    };
  });
}

function resolvePlannedElectronFiles(params: {
  readonly handleInfoByCompositeKey: ReadonlyMap<string, HandleInfo>;
  readonly plannedFiles: readonly PlannedTokenIndexingElectronFile[];
}): ElectronFileReadRequest[] {
  return params.plannedFiles.map((file) => {
    const handleInfo = params.handleInfoByCompositeKey.get(file.compositeKey);
    if (!handleInfo?.electronHandle) {
      throw new Error(`Missing planned Electron file handle for ${file.compositeKey}`);
    }

    return {
      compositeKey: file.compositeKey,
      filePath: file.filePath,
      fileSize: file.fileSize,
      folderId: file.folderId,
      handle: handleInfo.electronHandle,
    };
  });
}
