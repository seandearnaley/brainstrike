import { type IpcMainEvent, ipcMain } from 'electron';
import type { LlmHostManager } from './llm-host-manager';
import {
  assertLlmHostGeneratePayload,
  assertLlmHostResponseReport,
  assertLlmHostWarmupPayload,
  LLM_HOST_CANCEL_CHANNEL,
  LLM_HOST_ENSURE_STARTED_CHANNEL,
  LLM_HOST_GENERATE_CHANNEL,
  LLM_HOST_GET_STATUS_CHANNEL,
  LLM_HOST_REPORT_PROGRESS_CHANNEL,
  LLM_HOST_REPORT_RESPONSE_CHANNEL,
  LLM_HOST_REPORT_STATUS_CHANNEL,
  LLM_HOST_RESET_CHANNEL,
  LLM_HOST_STATUS_ADAPTER,
  LLM_HOST_STOP_CHANNEL,
  LLM_HOST_WARMUP_CHANNEL,
  type LlmHostStatusReport,
} from './llm-host-shared';
import { registerBackgroundRuntimeLifecycleIpcHandlers } from './register-background-runtime-lifecycle-ipc';

export function registerLlmHostIpcHandlers(manager: LlmHostManager): () => void {
  const unregisterLifecycle = registerBackgroundRuntimeLifecycleIpcHandlers<LlmHostStatusReport>({
    manager,
    assertStatus: LLM_HOST_STATUS_ADAPTER.assertStatus,
    channels: {
      ensureStarted: LLM_HOST_ENSURE_STARTED_CHANNEL,
      stop: LLM_HOST_STOP_CHANNEL,
      reset: LLM_HOST_RESET_CHANNEL,
      getStatus: LLM_HOST_GET_STATUS_CHANNEL,
      reportStatus: LLM_HOST_REPORT_STATUS_CHANNEL,
    },
  });

  ipcMain.handle(
    LLM_HOST_WARMUP_CHANNEL,
    async (event, payload: string | { clientRequestId?: string; modelId: string }) =>
      await (typeof payload === 'string'
        ? manager.warmup(event.sender, payload)
        : manager.warmupRequest(
            event.sender,
            assertLlmHostWarmupPayload({ ...payload, kind: 'warmup' })
          ))
  );
  ipcMain.handle(
    LLM_HOST_GENERATE_CHANNEL,
    async (event, payload: unknown) =>
      await manager.generate(event.sender, assertLlmHostGeneratePayload(payload))
  );
  ipcMain.handle(LLM_HOST_CANCEL_CHANNEL, async (event, requestId: string) => {
    await manager.cancel(event.sender, requestId);
  });

  const responseListener = (event: IpcMainEvent, response: unknown) => {
    manager.acceptResponseReport(event.sender.id, assertLlmHostResponseReport(response));
  };
  ipcMain.on(LLM_HOST_REPORT_RESPONSE_CHANNEL, responseListener);
  const progressListener = (event: IpcMainEvent, progress: unknown) => {
    manager.acceptResponseReport(event.sender.id, assertLlmHostResponseReport(progress));
  };
  ipcMain.on(LLM_HOST_REPORT_PROGRESS_CHANNEL, progressListener);

  return () => {
    unregisterLifecycle();
    ipcMain.removeHandler(LLM_HOST_CANCEL_CHANNEL);
    ipcMain.removeHandler(LLM_HOST_WARMUP_CHANNEL);
    ipcMain.removeHandler(LLM_HOST_GENERATE_CHANNEL);
    ipcMain.removeListener(LLM_HOST_REPORT_RESPONSE_CHANNEL, responseListener);
    ipcMain.removeListener(LLM_HOST_REPORT_PROGRESS_CHANNEL, progressListener);
  };
}
