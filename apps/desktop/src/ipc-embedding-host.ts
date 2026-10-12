import { ipcMain, type WebContents } from 'electron';
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
  EMBEDDING_HOST_REPORT_WEBGPU_ADAPTER_RESPONSE_CHANNEL,
  EMBEDDING_HOST_RESET_CHANNEL,
  EMBEDDING_HOST_STOP_CHANNEL,
  EMBEDDING_HOST_WEBGPU_ADAPTER_CHANNEL,
  type EmbeddingHostStatusReport,
} from './embedding-host-shared';
import { assertEmbeddingHostWebGpuAdapterResponseReport } from './embedding-host-webgpu-adapter';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry, type DesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { registerBackgroundRuntimeLifecycleIpcHandlers } from './register-background-runtime-lifecycle-ipc';

export function registerEmbeddingHostIpcHandlers(
  manager: EmbeddingHostManager,
  lifecycle: Pick<EmbeddingHostManager, 'stop'>
): () => void {
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
      manager: {
        acceptStatusReport: (senderId, report) => manager.acceptStatusReport(senderId, report),
        ensureStarted: (options) => manager.ensureStarted(options),
        getStatus: () => manager.getStatus(),
        reset: () => manager.reset(),
        stop: lifecycle.stop,
      },
    });
  const registry = createDesktopIpcRegistry({ ipcMain });

  const unregisterQueries = registerQueryEmbeddingRequests(registry, manager);
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
  // Settings asks the host that runs inference whether it has WebGPU (BST-1993).
  registry.registerAuthorizedInvoke(
    'embeddings',
    EMBEDDING_HOST_WEBGPU_ADAPTER_CHANNEL,
    { roles: ['visible-ui'] },
    () => manager.webgpuAdapter()
  );
  registry.registerEvent(
    'embeddings',
    EMBEDDING_HOST_REPORT_WEBGPU_ADAPTER_RESPONSE_CHANNEL,
    (event, response) =>
      manager.acceptWebGpuAdapterResponseReport(
        event.sender.id,
        assertEmbeddingHostWebGpuAdapterResponseReport(response)
      )
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
    unregisterQueries();
    for (const controller of documents.values()) {
      controller.abort(new Error('Embedding IPC disposed.'));
    }
    documents.clear();
    unregisterLifecycle();
    registry.unregisterAll();
  };
}

type QueryOutcome =
  | { readonly kind: 'result'; readonly embedding: number[] }
  | { readonly kind: 'cancelled' | 'error'; readonly error: unknown };

function assertQueryRequestId(value: unknown): string {
  if (!(typeof value === 'string' && value.length > 0 && value.length <= 128)) {
    throw new Error('Query requestId is required.');
  }
  return value;
}

function registerQueryEmbeddingRequests(
  registry: DesktopIpcRegistry,
  manager: EmbeddingHostManager
): () => void {
  const queries = new Map<
    string,
    { controller: AbortController; completion: Promise<QueryOutcome> }
  >();
  const senders = new Map<
    number,
    { sender: WebContents; tokens: Set<string>; onDestroyed: () => void }
  >();
  registry.registerAuthorizedInvoke(
    'embeddings',
    EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL,
    { roles: ['visible-ui'] },
    async (event, raw: unknown) => {
      if (!(raw && typeof raw === 'object')) {
        throw new Error('Invalid query request.');
      }
      const request = raw as Record<string, unknown>;
      const requestId = assertQueryRequestId(request['requestId']);
      const payload = assertEmbeddingHostQueryEmbeddingPayload(request['payload']);
      let owner = senders.get(event.sender.id);
      if (!owner) {
        const onDestroyed = (): void => {
          senders.delete(event.sender.id);
        };
        owner = { onDestroyed, sender: event.sender, tokens: new Set() };
        senders.set(event.sender.id, owner);
        event.sender.once('destroyed', onDestroyed);
      }
      if (owner.tokens.has(requestId)) {
        throw new Error('Query requestId was already used by this sender.');
      }
      owner.tokens.add(requestId);
      const key = `${event.sender.id}:${requestId}`;
      const controller = new AbortController();
      const onDestroyed = (): void => controller.abort(new Error('Query requester closed.'));
      event.sender.once('destroyed', onDestroyed);
      const completion: Promise<QueryOutcome> = Promise.resolve()
        .then(() => manager.queryEmbedding(payload, { signal: controller.signal }))
        .then(
          (embedding) => ({ embedding, kind: 'result' }),
          (error: unknown) => ({
            error,
            kind:
              controller.signal.aborted && error === controller.signal.reason
                ? 'cancelled'
                : 'error',
          })
        );
      queries.set(key, { completion, controller });
      try {
        const outcome = await completion;
        if (outcome.kind !== 'result') {
          throw outcome.error;
        }
        return outcome.embedding;
      } finally {
        queries.delete(key);
        event.sender.removeListener('destroyed', onDestroyed);
      }
    }
  );
  registry.registerAuthorizedInvoke(
    'embeddings',
    DESKTOP_IPC_CHANNELS.embeddingHost.cancelQueryEmbedding,
    { roles: ['visible-ui'] },
    async (event, raw: unknown) => {
      const requestId = assertQueryRequestId(raw);
      const query = queries.get(`${event.sender.id}:${requestId}`);
      if (!query) {
        return { cancelled: false };
      }
      query.controller.abort(new Error('Query embedding cancelled.'));
      const outcome = await query.completion;
      return { cancelled: outcome.kind === 'cancelled' };
    }
  );
  return () => {
    for (const query of queries.values()) {
      query.controller.abort(new Error('Embedding IPC disposed.'));
    }
    // Pending entries stay correlated until the existing manager physically settles.
    for (const owner of senders.values()) {
      owner.sender.removeListener('destroyed', owner.onDestroyed);
    }
    senders.clear();
  };
}
