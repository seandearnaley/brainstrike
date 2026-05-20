import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import { TOKEN_INDEXER_BATCH_YIELD_MS } from '../constants';

const LARGE_SELECTION_DIAGNOSTIC_FILE_THRESHOLD = 250;
const LARGE_SELECTION_DIAGNOSTIC_BYTES_THRESHOLD = 25 * 1024 * 1024;

export function normalizeSelectionPathForTokenCache(
  folderId: string,
  selectionPath: string
): string {
  return normalizeSelectionPathForFolder(selectionPath, folderId, {
    label: 'Token cache file path',
  });
}

export function shouldEmitLargeSelectionDiagnostics(params: {
  electronFileCount: number;
  estimatedElectronBytes: number;
  totalFileCount: number;
}): boolean {
  return (
    params.totalFileCount >= LARGE_SELECTION_DIAGNOSTIC_FILE_THRESHOLD ||
    params.electronFileCount >= LARGE_SELECTION_DIAGNOSTIC_FILE_THRESHOLD ||
    params.estimatedElectronBytes >= LARGE_SELECTION_DIAGNOSTIC_BYTES_THRESHOLD
  );
}

function yieldBetweenTokenIndexingBatches(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, TOKEN_INDEXER_BATCH_YIELD_MS);
  });
}

export async function yieldIfMoreTokenIndexingBatches(params: {
  nextIndex: number;
  onYield: () => void;
  totalCount: number;
}): Promise<void> {
  if (params.nextIndex >= params.totalCount) {
    return;
  }
  params.onYield();
  await yieldBetweenTokenIndexingBatches();
}
