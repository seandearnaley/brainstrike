export { POWER_BROADCAST_CHANNEL } from '@brainstrike/embedding-worker';
export type {
  EmbeddingWorkerController,
  EmbeddingWorkerOptions,
  EmbeddingWorkerPipelineCapacity,
} from './worker/embedding-worker';
export { startEmbeddingWorker } from './worker/embedding-worker';
export type {
  ForegroundEmbeddingGate,
  ForegroundEmbeddingGateOptions,
  RunCoordinatedQueryEmbeddingOptions,
  WaitForWorkerIdleOptions,
} from './worker/foreground-embedding-gate';
export {
  createForegroundEmbeddingGate,
  runCoordinatedQueryEmbedding,
  waitForWorkerIdle,
} from './worker/foreground-embedding-gate';
