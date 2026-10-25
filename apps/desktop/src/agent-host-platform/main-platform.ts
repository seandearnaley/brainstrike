import { toBoundaryResponseError } from '@brainstrike/agent-host/boundary-wire';
import { BoundaryFailureError, fault } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { createLogger, error as logError, fatal as logFatal } from '@brainstrike/logging';
import type { NativeChildObserver } from '@brainstrike/state-store/native-children';
import { Schema } from 'effect';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import { assertEmbeddingHostDocumentEmbeddingsPayload } from '../embedding-host-shared';
import type { LifecycleDelaySeam } from '../lifecycle-delay-seam';
import { nativeIndexBoundaryFailure } from '../native-index-boundary-failure';
import type { DesktopAdmissionReads } from './desktop-run-admission';
import {
  PLATFORM_FOLDER_GRANTED,
  PLATFORM_FOLDER_OPENED,
  PlatformFolderPathSchema,
} from './host-folders-wire';
import { PLATFORM_EMBEDDING_STOP, PLATFORM_RUNTIME_PREFERENCES_READ } from './host-index-wire';
import {
  type HostToolServiceCapabilities,
  refusalOutcome,
  serveHostToolServices,
} from './host-tool-services';
import { type DesktopMcpPlatformCapabilities, serveMainMcpStores } from './mcp-main-stores';
import {
  PLATFORM_DIAGNOSTICS_RECORD_METHOD,
  PLATFORM_EMBEDDING_DOCUMENTS,
  PLATFORM_EMBEDDING_RESTART,
  PlatformCatalogModelResultSchema,
  PlatformCatalogModelSchema,
  PlatformDiagnosticRecordSchema,
  PlatformEmbeddingDocumentsSchema,
  PlatformEmbeddingQuerySchema,
  type PlatformLocalModel,
  PlatformLocalModelResultSchema,
  PlatformLocalModelSchema,
  PlatformMemoryVectorsResultSchema,
  PlatformMemoryVectorsSchema,
  PlatformNativeChildSchema,
  PlatformObserverCandidatesResultSchema,
  PlatformObserverCandidatesSchema,
} from './platform-wire';

const logger = createLogger('DesktopMainPlatform');
/** An unscoped host record keeps no scope in Main's log either. */
const ROOT_LOG = { error: logError, fatal: logFatal } as const;
const PLATFORM_CLOSING = fault({
  category: 'availability',
  code: 'platform.closing',
  message: 'The desktop is closing this agent host.',
});
/** The admission reads Main serves; the folders, their binding and the index are the host's. */
export type MainAdmissionReads = Omit<
  DesktopAdmissionReads,
  'acquireWorkspace' | 'indexStatus' | 'liveWorkspaceRoots'
>;
export interface DesktopPlatformCapabilities {
  /**
   * BST-1930 stage e: the facts the agent host composes each run's admission
   * from. Main serves the reads and holds no selection.
   */
  readonly admission: MainAdmissionReads;
  /** ADR-0029 stage 4: what the host tells Main about the folders it mounts. */
  readonly folders?: {
    /** A granted folder: the OS recent documents and the File menu list it. */
    granted(path: string): void;
    /** A folder the host mounted for the user (an agent's worktree): the window shows it. */
    opened(path: string): void;
  };
  /** Main-owned stores and services the agent host's own tools read (cap-tools). */
  readonly hostTools?: HostToolServiceCapabilities;
  /** Main's E2E delay seam; `platform-ready` delays Main's answer to the host's readiness check. */
  readonly lifecycleDelays?: Pick<LifecycleDelaySeam, 'delay'>;
  /**
   * ADR-0007: Main's hidden embedding host, borrowed by an admitted thread's
   * local recall or retrieval tools through `platform/embedding/query`, and lent
   * to the host's workspace index.
   */
  readonly localEmbedding?: Pick<
    EmbeddingHostManager,
    'destroyAndRestart' | 'documentEmbeddings' | 'queryEmbedding' | 'stop'
  >;
  /** The Node host always composes its MCP runtime, which reaches these Main stores. */
  readonly mcp: DesktopMcpPlatformCapabilities;
  /** ADR-0017: Main's supervisor of the native processes the host reports starting. */
  readonly nativeChildren?: NativeChildObserver;
  /** The serialized assistant preferences, which name a local runtime's URL; null when unsaved. */
  readRuntimePreferences?(): Promise<string | null>;
}
type Execute = <T>(
  token: CancellationToken,
  work: (signal: AbortSignal) => Promise<T>
) => Promise<T>;
/** BST-1930 stage e: the reads a host-composed admission makes of Main's settings. */
function serveAdmissionReads(
  connection: MessageConnection,
  execute: Execute,
  reads: MainAdmissionReads
): void {
  connection.onRequest(
    'platform/admission/catalog-model',
    (input: unknown, token: CancellationToken) =>
      execute(token, async (signal) =>
        Schema.decodeUnknownSync(PlatformCatalogModelResultSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(
          await reads.catalogModel(
            Schema.decodeUnknownSync(PlatformCatalogModelSchema, {
              errors: 'all',
              onExcessProperty: 'error',
            })(input),
            signal
          )
        )
      )
  );
  connection.onRequest<PlatformLocalModel, unknown>(
    'platform/admission/local-model',
    (input: unknown, token: CancellationToken) =>
      execute(token, async (signal) => {
        const localRuntimeModel = reads.localRuntimeModel;
        if (!localRuntimeModel) {
          throw new Error('This desktop serves no local runtime catalog');
        }
        return Schema.decodeUnknownSync(PlatformLocalModelResultSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(
          await localRuntimeModel(
            Schema.decodeUnknownSync(PlatformLocalModelSchema, {
              errors: 'all',
              onExcessProperty: 'error',
            })(input),
            signal
          )
        );
      })
  );
  connection.onRequest('platform/admission/observers', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) =>
      Schema.decodeUnknownSync(PlatformObserverCandidatesResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(
        await reads.enabledObservers(
          Schema.decodeUnknownSync(PlatformObserverCandidatesSchema, {
            errors: 'all',
            onExcessProperty: 'error',
          })(input).candidates,
          signal
        )
      )
    )
  );
  connection.onRequest(
    'platform/admission/memory-vectors',
    (input: unknown, token: CancellationToken) =>
      execute(token, async (signal) =>
        Schema.decodeUnknownSync(PlatformMemoryVectorsResultSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(
          (await reads.memoryVectors(
            Schema.decodeUnknownSync(PlatformMemoryVectorsSchema, {
              errors: 'all',
              onExcessProperty: 'error',
            })(input).settings,
            signal
          )) ?? null
        )
      )
  );
}
/** One private connection borrows existing owners; it constructs no platform store. */
export function serveDesktopPlatform(
  connection: MessageConnection,
  capabilities: DesktopPlatformCapabilities
): {
  close(): Promise<void>;
} {
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  const mcpStores = serveMainMcpStores(connection, capabilities.mcp);
  const nativeChildren = capabilities.nativeChildren;
  if (nativeChildren) {
    connection.onNotification('platform/native-child/started', (input: unknown) =>
      nativeChildren.started(
        Schema.decodeUnknownSync(PlatformNativeChildSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(input)
      )
    );
    connection.onNotification('platform/native-child/exited', (input: unknown) =>
      nativeChildren.exited(
        Schema.decodeUnknownSync(PlatformNativeChildSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(input)
      )
    );
  }
  let closing: Promise<void> | undefined;
  const execute = <T>(
    token: CancellationToken,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    if (closing) {
      return Promise.reject(
        toBoundaryResponseError(new BoundaryFailureError(PLATFORM_CLOSING), (message, fields) =>
          logger.error(message, fields)
        )
      );
    }
    const controller = new AbortController();
    controllers.add(controller);
    const cancel = (): void => controller.abort(new Error('Platform operation cancelled'));
    const subscription = token.onCancellationRequested(cancel);
    if (token.isCancellationRequested) {
      cancel();
    }
    const task = Promise.resolve()
      .then(() => work(controller.signal))
      .catch((cause: unknown) => {
        // A typed failure reaches the host as the response data; anything else
        // is logged here and travels as the fixed internal fault (BST-2010).
        const log = (message: string, fields: Readonly<Record<string, unknown>>): void =>
          logger.error(message, fields);
        throw toBoundaryResponseError(
          new BoundaryFailureError(nativeIndexBoundaryFailure(cause, log)),
          log
        );
      });
    pending.add(task);
    const settled = (): void => {
      subscription.dispose();
      controllers.delete(controller);
      pending.delete(task);
    };
    task.then(settled, settled);
    return task;
  };
  connection.onRequest(
    PLATFORM_DIAGNOSTICS_RECORD_METHOD,
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { record } = wireDecoder(PlatformDiagnosticRecordSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        // BST-2202: Main's existing logger owns the file and durable diagnostic
        // sinks, as for MCP's records. The host's logger redacted it already.
        const relog = record.scope === undefined ? ROOT_LOG : createLogger(record.scope);
        relog[record.level](...record.args);
        return null;
      })
  );
  connection.onRequest('platform/ready', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      wireDecoder(Schema.Record(Schema.String, Schema.Never), {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      await capabilities.lifecycleDelays?.delay('platform-ready');
      signal.throwIfAborted();
      return null;
    })
  );
  connection.onRequest('platform/embedding/query', (input: unknown, token: CancellationToken) =>
    // The outcome union crosses as JSON; the host parses it (RefusableOutcomeSchema).
    execute(token, async (signal): Promise<unknown> => {
      const { request } = Schema.decodeUnknownSync(PlatformEmbeddingQuerySchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      const embeddings = capabilities.localEmbedding;
      if (!embeddings) {
        throw new Error('This desktop has no embedding host for host threads');
      }
      // A retrieval tool's query or an admitted local recall embedder's, as the host sent it.
      return await refusalOutcome(() => embeddings.queryEmbedding(request, { signal }));
    })
  );
  // The host's index embeds its documents in Main's hidden embedding renderer (ADR-0007).
  connection.onRequest(PLATFORM_EMBEDDING_DOCUMENTS, (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const { request } = Schema.decodeUnknownSync(PlatformEmbeddingDocumentsSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      const embeddings = capabilities.localEmbedding;
      if (!embeddings) {
        throw new Error('This desktop has no embedding host for the workspace index');
      }
      return await embeddings.documentEmbeddings(
        assertEmbeddingHostDocumentEmbeddingsPayload(request),
        { signal }
      );
    })
  );
  // Retry indexing's remedy: the embedding renderer's own owner restarts it (BST-2104).
  connection.onRequest(PLATFORM_EMBEDDING_RESTART, (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      wireDecoder(Schema.Record(Schema.String, Schema.Never), {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      const embeddings = capabilities.localEmbedding;
      if (!embeddings) {
        throw new Error('This desktop has no embedding host to restart');
      }
      await embeddings.destroyAndRestart();
      return null;
    })
  );
  connection.onRequest(PLATFORM_EMBEDDING_STOP, (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      wireDecoder(Schema.Record(Schema.String, Schema.Never), {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      const embeddings = capabilities.localEmbedding;
      if (!embeddings) {
        throw new Error('This desktop has no embedding host to stop');
      }
      await embeddings.stop();
      return null;
    })
  );
  connection.onRequest(
    PLATFORM_RUNTIME_PREFERENCES_READ,
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        wireDecoder(Schema.Record(Schema.String, Schema.Never), {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        return (await capabilities.readRuntimePreferences?.()) ?? null;
      })
  );
  const folders = capabilities.folders;
  if (folders) {
    const decodeFolder = wireDecoder(PlatformFolderPathSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    });
    connection.onNotification(PLATFORM_FOLDER_GRANTED, (input: unknown) =>
      folders.granted(decodeFolder(input).path)
    );
    connection.onNotification(PLATFORM_FOLDER_OPENED, (input: unknown) =>
      folders.opened(decodeFolder(input).path)
    );
  }
  serveAdmissionReads(connection, execute, capabilities.admission);
  serveHostToolServices(connection, execute, capabilities.hostTools);
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(async () => {
      for (const controller of controllers) {
        controller.abort(new Error('Desktop platform is closing'));
      }
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
      mcpStores.close();
    });
    return closing;
  };
  const disconnect = (): Promise<void> => {
    const joined = close();
    // vscode-jsonrpc close does not reject pending responses. Dispose before
    // joining executors so a lost progress acknowledgement cannot hold a tail.
    connection.dispose();
    return joined;
  };
  connection.onClose(() => {
    // Keep the rejected join observable through the owner returned below.
    void disconnect().catch(() => undefined);
  });
  connection.onDispose(() => {
    void close().catch(() => undefined);
  });
  // The host keeps its Root when this fails, so the failure is logged here with
  // every inner cause, under the correlation id the host's fault carries (BST-2192).
  connection.onRequest('platform/close', () =>
    close().catch((cause: unknown) => {
      throw toBoundaryResponseError(cause, (message, fields) => logger.error(message, fields));
    })
  );
  connection.listen();
  return {
    close: disconnect,
  };
}
