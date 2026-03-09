import type { EmbeddingHostManager } from './embedding-host-manager';
import {
  EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
  EMBEDDING_HOST_GET_STATUS_CHANNEL,
  EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
  EMBEDDING_HOST_RESET_CHANNEL,
  EMBEDDING_HOST_STATUS_ADAPTER,
  EMBEDDING_HOST_STOP_CHANNEL,
  type EmbeddingHostStatusReport,
} from './embedding-host-shared';
import { registerBackgroundRuntimeLifecycleIpcHandlers } from './register-background-runtime-lifecycle-ipc';

export function registerEmbeddingHostIpcHandlers(manager: EmbeddingHostManager): () => void {
  return registerBackgroundRuntimeLifecycleIpcHandlers<EmbeddingHostStatusReport>({
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
}
