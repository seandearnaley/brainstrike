import { ipcMain } from 'electron';
import type { LlmHostManager } from './llm-host-manager';
import {
  assertLlmHostCancelIpcRequestId,
  assertLlmHostGeneratePayload,
  assertLlmHostResponseReport,
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
  normalizeLlmHostWarmupIpcPayload,
} from './llm-host-shared';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { registerBackgroundRuntimeLifecycleIpcHandlers } from './register-background-runtime-lifecycle-ipc';

export function registerLlmHostIpcHandlers(manager: LlmHostManager): () => void {
  const unregisterLifecycle = registerBackgroundRuntimeLifecycleIpcHandlers<LlmHostStatusReport>({
    assertStatus: LLM_HOST_STATUS_ADAPTER.assertStatus,
    channels: {
      ensureStarted: LLM_HOST_ENSURE_STARTED_CHANNEL,
      getStatus: LLM_HOST_GET_STATUS_CHANNEL,
      reportStatus: LLM_HOST_REPORT_STATUS_CHANNEL,
      reset: LLM_HOST_RESET_CHANNEL,
      stop: LLM_HOST_STOP_CHANNEL,
    },
    domain: 'llm-host',
    manager,
  });
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'llm-host',
    LLM_HOST_WARMUP_CHANNEL,
    async (event, payload: unknown) =>
      await manager.warmupRequest(
        event.sender,
        normalizeLlmHostWarmupIpcPayload(payload, () => crypto.randomUUID())
      )
  );
  registry.registerInvoke(
    'llm-host',
    LLM_HOST_GENERATE_CHANNEL,
    async (event, payload: unknown) =>
      await manager.generate(event.sender, assertLlmHostGeneratePayload(payload))
  );
  registry.registerInvoke(
    'llm-host',
    LLM_HOST_CANCEL_CHANNEL,
    async (event, requestId: unknown) => {
      await manager.cancel(event.sender, assertLlmHostCancelIpcRequestId(requestId));
    }
  );

  registry.registerEvent('llm-host', LLM_HOST_REPORT_RESPONSE_CHANNEL, (event, response) => {
    manager.acceptResponseReport(event.sender.id, assertLlmHostResponseReport(response));
  });
  registry.registerEvent('llm-host', LLM_HOST_REPORT_PROGRESS_CHANNEL, (event, report) => {
    manager.acceptResponseReport(event.sender.id, assertLlmHostResponseReport(report));
  });

  return () => {
    unregisterLifecycle();
    registry.unregisterAll();
  };
}
