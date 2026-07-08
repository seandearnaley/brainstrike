import { ipcMain } from 'electron';
import type { EmbeddingHostManager } from './embedding-host-manager';
import {
  assertEmbeddingHostQueryEmbeddingPayload,
  assertEmbeddingHostQueryEmbeddingResponseReport,
  assertEmbeddingHostStatus,
  EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
  EMBEDDING_HOST_GET_STATUS_CHANNEL,
  EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL,
  EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL,
  EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
  EMBEDDING_HOST_RESET_CHANNEL,
  EMBEDDING_HOST_STOP_CHANNEL,
  type EmbeddingHostStatusReport,
} from './embedding-host-shared';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { registerBackgroundRuntimeLifecycleIpcHandlers } from './register-background-runtime-lifecycle-ipc';

export function registerEmbeddingHostIpcHandlers(manager: EmbeddingHostManager): () => void {
  const unregisterLifecycle =
    registerBackgroundRuntimeLifecycleIpcHandlers<EmbeddingHostStatusReport>({
      assertStatus: assertEmbeddingHostStatus,
      channels: {
        ensureStarted: EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
        getStatus: EMBEDDING_HOST_GET_STATUS_CHANNEL,
        reportStatus: EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
        reset: EMBEDDING_HOST_RESET_CHANNEL,
        stop: EMBEDDING_HOST_STOP_CHANNEL,
      },
      domain: 'embeddings',
      manager,
    });
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'embeddings',
    EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL,
    async (_event, payload) =>
      manager.queryEmbedding(assertEmbeddingHostQueryEmbeddingPayload(payload))
  );
  registry.registerEvent(
    'embeddings',
    EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL,
    (event, response) => {
      manager.acceptQueryEmbeddingResponseReport(
        event.sender.id,
        assertEmbeddingHostQueryEmbeddingResponseReport(response)
      );
    }
  );

  return () => {
    unregisterLifecycle();
    registry.unregisterAll();
  };
}
