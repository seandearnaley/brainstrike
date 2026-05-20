import { ipcMain } from 'electron';
import type { ChunkingHostManager } from './chunking-host-manager';
import {
  assertChunkingHostChunkBatchRequestPayload,
  assertChunkingHostChunkFileRequestPayload,
  assertChunkingHostResponseReport,
  assertChunkingHostStatusReport,
  CHUNKING_HOST_CHUNK_BATCH_CHANNEL,
  CHUNKING_HOST_CHUNK_FILE_CHANNEL,
  CHUNKING_HOST_ENSURE_STARTED_CHANNEL,
  CHUNKING_HOST_GET_STATUS_CHANNEL,
  CHUNKING_HOST_REPORT_RESPONSE_CHANNEL,
  CHUNKING_HOST_REPORT_STATUS_CHANNEL,
  CHUNKING_HOST_RESET_CHANNEL,
  CHUNKING_HOST_STOP_CHANNEL,
} from './chunking-host-shared';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { registerBackgroundRuntimeLifecycleIpcHandlers } from './register-background-runtime-lifecycle-ipc';

export function registerChunkingHostIpcHandlers(manager: ChunkingHostManager): () => void {
  const unregisterLifecycle = registerBackgroundRuntimeLifecycleIpcHandlers({
    manager,
    assertStatus: assertChunkingHostStatusReport,
    channels: {
      ensureStarted: CHUNKING_HOST_ENSURE_STARTED_CHANNEL,
      stop: CHUNKING_HOST_STOP_CHANNEL,
      reset: CHUNKING_HOST_RESET_CHANNEL,
      getStatus: CHUNKING_HOST_GET_STATUS_CHANNEL,
      reportStatus: CHUNKING_HOST_REPORT_STATUS_CHANNEL,
    },
    domain: 'chunking-host',
  });
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'chunking-host',
    CHUNKING_HOST_CHUNK_FILE_CHANNEL,
    async (event, payload: unknown) =>
      manager.chunkFile(event.sender.id, assertChunkingHostChunkFileRequestPayload(payload))
  );
  registry.registerInvoke(
    'chunking-host',
    CHUNKING_HOST_CHUNK_BATCH_CHANNEL,
    async (event, payload: unknown) =>
      manager.chunkBatch(event.sender.id, assertChunkingHostChunkBatchRequestPayload(payload))
  );
  registry.registerEvent(
    'chunking-host',
    CHUNKING_HOST_REPORT_RESPONSE_CHANNEL,
    (event, payload) => {
      manager.acceptResponseReport(event.sender.id, assertChunkingHostResponseReport(payload));
    }
  );

  return () => {
    unregisterLifecycle();
    registry.unregisterAll();
  };
}
