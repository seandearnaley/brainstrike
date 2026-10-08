// The Node implementation is shared; Desktop retains its existing public surface.
export {
  classifyDatabaseCorruption,
  type DatabaseCorruptionSignal,
  type DatabaseCorruptionSqlstate,
  isCorruptionError,
} from '@brainstrike/assistant-service/node-workspace-services';
