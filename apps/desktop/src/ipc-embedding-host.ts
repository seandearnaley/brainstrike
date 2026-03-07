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
  if (!value || typeof value !== 'object') {
    throw new Error('Embedding host status report must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate['state'] !== 'starting' &&
    candidate['state'] !== 'running' &&
    candidate['state'] !== 'stopped' &&
    candidate['state'] !== 'error'
  ) {
    throw new Error('Embedding host status report has invalid state.');
  }
  if (typeof candidate['active'] !== 'boolean') {
    throw new Error('Embedding host status report must include active boolean.');
  }
  if (candidate['lastError'] !== null && typeof candidate['lastError'] !== 'string') {
    throw new Error('Embedding host status report must include string or null lastError.');
  }
  return {
    state: candidate['state'],
    active: candidate['active'],
    lastError: candidate['lastError'],
  } as EmbeddingHostStatusReport;
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
