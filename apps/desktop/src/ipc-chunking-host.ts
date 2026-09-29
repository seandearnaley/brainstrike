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

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

export function registerChunkingHostIpcHandlers(manager: ChunkingHostManager): () => void {
  const unregisterLifecycle = registerBackgroundRuntimeLifecycleIpcHandlers({
    assertStatus: assertChunkingHostStatusReport,
    channels: {
      ensureStarted: CHUNKING_HOST_ENSURE_STARTED_CHANNEL,
      getStatus: CHUNKING_HOST_GET_STATUS_CHANNEL,
      reportStatus: CHUNKING_HOST_REPORT_STATUS_CHANNEL,
      reset: CHUNKING_HOST_RESET_CHANNEL,
      stop: CHUNKING_HOST_STOP_CHANNEL,
    },
    domain: 'chunking-host',
    manager,
  });
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerUnauthenticatedInvoke(
    'chunking-host',
    CHUNKING_HOST_CHUNK_FILE_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
    async (event, payload: unknown) =>
      manager.chunkFile(event.sender.id, assertChunkingHostChunkFileRequestPayload(payload))
  );
  registry.registerUnauthenticatedInvoke(
    'chunking-host',
    CHUNKING_HOST_CHUNK_BATCH_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
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
