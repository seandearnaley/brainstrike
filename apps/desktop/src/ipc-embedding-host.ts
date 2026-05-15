import { type IpcMainEvent, ipcMain } from 'electron';
import type { EmbeddingHostManager } from './embedding-host-manager';
import {
  assertEmbeddingHostQueryEmbeddingResponseReport,
  EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
  EMBEDDING_HOST_GET_STATUS_CHANNEL,
  EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL,
  EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
  EMBEDDING_HOST_RESET_CHANNEL,
  EMBEDDING_HOST_STATUS_ADAPTER,
  EMBEDDING_HOST_STOP_CHANNEL,
  type EmbeddingHostStatusReport,
} from './embedding-host-shared';
import { registerBackgroundRuntimeLifecycleIpcHandlers } from './register-background-runtime-lifecycle-ipc';

export function registerEmbeddingHostIpcHandlers(manager: EmbeddingHostManager): () => void {
  const unregisterLifecycle =
    registerBackgroundRuntimeLifecycleIpcHandlers<EmbeddingHostStatusReport>({
      manager,
      assertStatus: EMBEDDING_HOST_STATUS_ADAPTER.assertStatus,
      channels: {
        ensureStarted: EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
        stop: EMBEDDING_HOST_STOP_CHANNEL,
        reset: EMBEDDING_HOST_RESET_CHANNEL,
        getStatus: EMBEDDING_HOST_GET_STATUS_CHANNEL,
        reportStatus: EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
      },
    });

  const queryEmbeddingResponseListener = (event: IpcMainEvent, response: unknown) => {
    manager.acceptQueryEmbeddingResponseReport(
      event.sender.id,
      assertEmbeddingHostQueryEmbeddingResponseReport(response)
    );
  };
  ipcMain.on(
    EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL,
    queryEmbeddingResponseListener
  );

  return () => {
    unregisterLifecycle();
    ipcMain.removeListener(
      EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL,
      queryEmbeddingResponseListener
    );
  };
}
