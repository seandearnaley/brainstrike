import { type IpcMainEvent, type IpcMainInvokeEvent, ipcMain } from 'electron';
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
  });
  ipcMain.handle(
    CHUNKING_HOST_CHUNK_FILE_CHANNEL,
    async (event: IpcMainInvokeEvent, payload: unknown) =>
      manager.chunkFile(event.sender.id, assertChunkingHostChunkFileRequestPayload(payload))
  );
  ipcMain.handle(
    CHUNKING_HOST_CHUNK_BATCH_CHANNEL,
    async (event: IpcMainInvokeEvent, payload: unknown) =>
      manager.chunkBatch(event.sender.id, assertChunkingHostChunkBatchRequestPayload(payload))
  );
  const responseReportListener = (event: IpcMainEvent, payload: unknown) => {
    manager.acceptResponseReport(event.sender.id, assertChunkingHostResponseReport(payload));
  };
  ipcMain.on(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL, responseReportListener);

  return () => {
    unregisterLifecycle();
    ipcMain.removeHandler(CHUNKING_HOST_CHUNK_FILE_CHANNEL);
    ipcMain.removeHandler(CHUNKING_HOST_CHUNK_BATCH_CHANNEL);
    ipcMain.removeListener(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL, responseReportListener);
  };
}
