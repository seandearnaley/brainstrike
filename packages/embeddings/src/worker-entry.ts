export { POWER_BROADCAST_CHANNEL } from '@brainstrike/embedding-worker';
export type {
  ForegroundEmbeddingGate,
  ForegroundEmbeddingGateOptions,
  RunCoordinatedQueryEmbeddingOptions,
  WaitForWorkerIdleOptions,
} from './worker/foreground-embedding-gate.ts';
export {
  createForegroundEmbeddingGate,
  runCoordinatedQueryEmbedding,
  waitForWorkerIdle,
} from './worker/foreground-embedding-gate.ts';
