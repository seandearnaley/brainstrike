export { POWER_BROADCAST_CHANNEL } from '@brainstrike/embedding-worker';
export type {
  EmbeddingWorkerController,
  EmbeddingWorkerOptions,
  EmbeddingWorkerPipelineCapacity,
} from './worker/embedding-worker.js';
export { startEmbeddingWorker } from './worker/embedding-worker.js';
export type {
  ForegroundEmbeddingGate,
  ForegroundEmbeddingGateOptions,
  RunCoordinatedQueryEmbeddingOptions,
  WaitForWorkerIdleOptions,
} from './worker/foreground-embedding-gate.js';
export {
  createForegroundEmbeddingGate,
  runCoordinatedQueryEmbedding,
  waitForWorkerIdle,
} from './worker/foreground-embedding-gate.js';
