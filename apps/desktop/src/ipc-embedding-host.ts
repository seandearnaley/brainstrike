import { ipcMain } from 'electron';
import type { EmbeddingHostManager } from './embedding-host-manager';
import {
  assertEmbeddingHostDocumentEmbeddingsPayload,
  assertEmbeddingHostDocumentEmbeddingsResponseReport,
  assertEmbeddingHostQueryEmbeddingPayload,
  assertEmbeddingHostQueryEmbeddingResponseReport,
  assertEmbeddingHostStatus,
  EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_CHANNEL,
  EMBEDDING_HOST_ENSURE_STARTED_CHANNEL,
  EMBEDDING_HOST_GET_STATUS_CHANNEL,
  EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL,
  EMBEDDING_HOST_REPORT_DOCUMENT_EMBEDDINGS_RESPONSE_CHANNEL,
  EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL,
  EMBEDDING_HOST_REPORT_STATUS_CHANNEL,
  EMBEDDING_HOST_RESET_CHANNEL,
  EMBEDDING_HOST_STOP_CHANNEL,
  type EmbeddingHostStatusReport,
} from './embedding-host-shared';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { registerBackgroundRuntimeLifecycleIpcHandlers } from './register-background-runtime-lifecycle-ipc';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

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

  registry.registerUnauthenticatedInvoke(
    'embeddings',
    EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
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

  const documents = new Map<string, AbortController>();
  registry.registerAuthorizedInvoke(
    'embeddings',
    EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_CHANNEL,
    { roles: ['visible-ui'] },
    async (event, raw: unknown) => {
      if (!(raw && typeof raw === 'object')) {
        throw new Error('Invalid document request.');
      }
      const request = raw as Record<string, unknown>;
      const requestId = request['requestId'];
      if (!(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128)) {
        throw new Error('Document requestId is required.');
      }
      const payload = assertEmbeddingHostDocumentEmbeddingsPayload(request['payload']);
      const key = `${event.sender.id}:${requestId}`;
      if (documents.has(key)) {
        throw new Error('Document request is already in flight.');
      }
      if (documents.size >= 8) {
        throw new Error('Document request admission limit reached.');
      }
      const controller = new AbortController();
      documents.set(key, controller);
      const onDestroyed = (): void => controller.abort(new Error('Document requester closed.'));
      event.sender.once('destroyed', onDestroyed);
      try {
        return await manager.documentEmbeddings(payload, { signal: controller.signal });
      } finally {
        documents.delete(key);
        event.sender.removeListener('destroyed', onDestroyed);
      }
    }
  );
  registry.registerAuthorizedInvoke(
    'embeddings',
    DESKTOP_IPC_CHANNELS.embeddingHost.cancelDocumentEmbeddings,
    { roles: ['visible-ui'] },
    (event, requestId: unknown) => {
      if (!(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128)) {
        throw new Error('Document cancellation requestId is required.');
      }
      documents
        .get(`${event.sender.id}:${requestId}`)
        ?.abort(new Error('Document embeddings canceled.'));
    }
  );
  registry.registerEvent(
    'embeddings',
    EMBEDDING_HOST_REPORT_DOCUMENT_EMBEDDINGS_RESPONSE_CHANNEL,
    (event, response) =>
      manager.acceptDocumentEmbeddingsResponseReport(
        event.sender.id,
        assertEmbeddingHostDocumentEmbeddingsResponseReport(response)
      )
  );

  return () => {
    for (const controller of documents.values()) {
      controller.abort(new Error('Embedding IPC disposed.'));
    }
    documents.clear();
    unregisterLifecycle();
    registry.unregisterAll();
  };
}
