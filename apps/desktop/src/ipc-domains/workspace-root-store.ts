// The Node implementation is shared; Desktop retains its existing public surface.
export {
  clearLastFolderIfMatches,
  readLastFolder,
  readStoredRoots,
  readStoredRootsOrQuarantine,
  writeLastFolder,
  writeLastFolderBestEffort,
  writeStoredRoots,
} from '@brainstrike/assistant-service/node-workspace-services';
