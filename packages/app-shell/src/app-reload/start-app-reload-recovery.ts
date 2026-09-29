import { installChunkLoadErrorListener } from '@brainstrike/ui';
import { type ChunkReloadGuardOptions, consumeChunkReloadMarker } from './chunk-reload-guard';

/**
 * Wires failed-chunk recovery into one renderer window. Call it BEFORE the first
 * render, so a marker left by the last reload has already flagged the notice.
 * Returns the uninstall, for an entry that re-executes under HMR.
 */
export function startAppReloadRecovery(options: ChunkReloadGuardOptions): () => void {
  const uninstall = installChunkLoadErrorListener(window);
  consumeChunkReloadMarker(options);
  return uninstall;
}
