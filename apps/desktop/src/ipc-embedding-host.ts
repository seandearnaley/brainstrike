import { assertBackgroundRuntimeStatus } from '@brainstrike/worker-runtime';
import { type IpcMainEvent, ipcMain } from 'electron';
import type { EmbeddingHostManager } from './embedding-host-manager';
import {
  EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
  EMBEDDING_HOST_GET_STATUS_CHANNEL,
  EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
  EMBEDDING_HOST_RESET_CHANNEL,
  EMBEDDING_HOST_STOP_CHANNEL,
  type EmbeddingHostStatusReport,
} from './embedding-host-shared';

function assertEmbeddingHostStatusReport(value: unknown): EmbeddingHostStatusReport {
  return assertBackgroundRuntimeStatus(value, 'embedding-host') as EmbeddingHostStatusReport;
}

export function registerEmbeddingHostIpcHandlers(manager: EmbeddingHostManager): () => void {
  ipcMain.handle(EMBEDDING_HOST_ENSURE_STARTED_CHANNEL, async () =>
    manager.ensureStarted({ waitForRunning: true })
  );
  ipcMain.handle(EMBEDDING_HOST_STOP_CHANNEL, async () => manager.stop());
  ipcMain.handle(EMBEDDING_HOST_RESET_CHANNEL, async () => manager.reset());
  ipcMain.handle(EMBEDDING_HOST_GET_STATUS_CHANNEL, async () => manager.getStatus());
  ipcMain.on(EMBEDDING_HOST_REPORT_STATUS_CHANNEL, (event: IpcMainEvent, payload: unknown) => {
    manager.acceptStatusReport(event.sender.id, assertEmbeddingHostStatusReport(payload));
  });

  return () => {
    ipcMain.removeHandler(EMBEDDING_HOST_ENSURE_STARTED_CHANNEL);
    ipcMain.removeHandler(EMBEDDING_HOST_STOP_CHANNEL);
    ipcMain.removeHandler(EMBEDDING_HOST_RESET_CHANNEL);
    ipcMain.removeHandler(EMBEDDING_HOST_GET_STATUS_CHANNEL);
    ipcMain.removeAllListeners(EMBEDDING_HOST_REPORT_STATUS_CHANNEL);
  };
}
