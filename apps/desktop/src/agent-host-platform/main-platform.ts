import type { HostPlatform } from '@brainstrike/agent-host';
import { toBoundaryResponseError } from '@brainstrike/agent-host/boundary-wire';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import { BoundaryFailureError, fault } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { createLogger, error as logError, fatal as logFatal } from '@brainstrike/logging';
import { Schema } from 'effect';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import type { LifecycleDelaySeam } from '../lifecycle-delay-seam';
import { nativeIndexBoundaryFailure } from '../native-index-boundary-failure';
import type { DesktopAdmissionReads } from './desktop-run-admission';
import type { DesktopWorkspaceBindingBorrow } from './desktop-workspace-binding';
import {
  type HostToolServiceCapabilities,
  refusalOutcome,
  serveHostToolServices,
} from './host-tool-services';
import { type DesktopMcpPlatformCapabilities, serveMainMcpStores } from './mcp-main-stores';
import {
  PLATFORM_DIAGNOSTICS_RECORD_METHOD,
  PlatformCatalogModelResultSchema,
  PlatformCatalogModelSchema,
  PlatformDiagnosticRecordSchema,
  PlatformEmbeddingQuerySchema,
  PlatformIndexRefreshSchema,
  type PlatformLocalModel,
  PlatformLocalModelResultSchema,
  PlatformLocalModelSchema,
  PlatformMemoryVectorsResultSchema,
  PlatformMemoryVectorsSchema,
  PlatformObserverCandidatesResultSchema,
  PlatformObserverCandidatesSchema,
  PlatformWorkspaceAcquireResultSchema,
  PlatformWorkspaceAcquireSchema,
  PlatformWorkspaceBindingRequestSchema,
  PlatformWorkspaceLeaseSchema,
  PlatformWorktreeFolderSchema,
} from './platform-wire';

const logger = createLogger('DesktopMainPlatform');
/** An unscoped host record keeps no scope in Main's log either. */
const ROOT_LOG = { error: logError, fatal: logFatal } as const;
const PLATFORM_CLOSING = fault({
  category: 'availability',
  code: 'platform.closing',
  message: 'The desktop is closing this agent host.',
});
export interface DesktopPlatformCapabilities {
  /**
   * BST-1930 stage e: the facts the agent host composes each run's admission
   * from. Main serves the reads and holds no selection.
   */
  readonly admission: DesktopAdmissionReads;
  /** Join Main-owned Root borrowers before Core releases its canonical writer. */
  closeRootCapabilities?(): Promise<void>;
  /** Main-owned stores and services the agent host's own tools read (cap-tools). */
  readonly hostTools?: HostToolServiceCapabilities;
  /** Main's E2E delay seam; `platform-ready` delays Main's answer to the host's readiness check. */
  readonly lifecycleDelays?: Pick<LifecycleDelaySeam, 'delay'>;
  /**
   * ADR-0007: Main's hidden embedding host, borrowed by an admitted thread's
   * local recall or retrieval tools through `platform/embedding/query`.
   */
  readonly localEmbedding?: Pick<EmbeddingHostManager, 'queryEmbedding'>;
  /** The Node host always composes its MCP runtime, which reaches these Main stores. */
  readonly mcp: DesktopMcpPlatformCapabilities;
  /**
   * ADR-0028 step 3: mounts a worktree an agent created as a workspace folder
   * and asks the window to show it, as for any folder Main opens.
   */
  openWorktreeFolder?(path: string): Promise<{ displayName: string; path: string; rootId: string }>;
  /** Main's native index rescans a root after a rewind restored it on disk. */
  refreshWorkspaceIndex?(rootId: string): Promise<void>;
  /** The live path of a mounted profile root; rejects an unknown root. */
  resolveWorkspaceRoot?(rootId: string): Promise<string>;
  readonly validateWorkspaceBinding?: HostPlatform['validateWorkspaceBinding'];
}
type Execute = <T>(
  token: CancellationToken,
  work: (signal: AbortSignal) => Promise<T>
) => Promise<T>;
/**
 * BST-1930 stage e: the reads a host-composed admission makes of Main's facts.
 * A workspace borrow is held under the lease id the host chose, until the host
 * releases it or the connection closes.
 */
function serveAdmissionReads(
  connection: MessageConnection,
  execute: Execute,
  reads: DesktopAdmissionReads,
  leases: Map<string, DesktopWorkspaceBindingBorrow>
): void {
  const lease = (input: unknown): DesktopWorkspaceBindingBorrow => {
    const borrowed = leases.get(
      Schema.decodeUnknownSync(PlatformWorkspaceLeaseSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input).leaseId
    );
    if (!borrowed) {
      throw new Error('The workspace lease is not held');
    }
    return borrowed;
  };
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
  connection.onRequest('platform/admission/roots', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      wireDecoder(Schema.Record(Schema.String, Schema.Never), {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      return Schema.decodeUnknownSync(CliWorkspaceRootsSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(await reads.liveWorkspaceRoots(signal));
    })
  );
  connection.onRequest(
    'platform/admission/index-status',
    (input: unknown, token: CancellationToken): Promise<unknown> =>
      execute(token, async (signal) => {
        wireDecoder(Schema.Record(Schema.String, Schema.Never), {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        return await reads.indexStatus(signal);
      })
  );
  connection.onRequest(
    'platform/admission/workspace/acquire',
    (input: unknown, token: CancellationToken) =>
      execute(token, async (signal) => {
        const { binding, leaseId, threadId } = Schema.decodeUnknownSync(
          PlatformWorkspaceAcquireSchema,
          { errors: 'all', onExcessProperty: 'error' }
        )(input);
        if (leases.has(leaseId)) {
          throw new Error('The workspace lease is already held');
        }
        const borrowed = await reads.acquireWorkspace({ binding, signal, threadId });
        try {
          // A borrow the host stopped waiting for, or whose roots cannot cross, is returned.
          signal.throwIfAborted();
          const acquired = Schema.decodeUnknownSync(PlatformWorkspaceAcquireResultSchema, {
            errors: 'all',
            onExcessProperty: 'error',
          })({
            roots: [...borrowed.roots],
          });
          leases.set(leaseId, borrowed);
          return acquired;
        } catch (cause) {
          try {
            await borrowed.close();
          } catch (cleanup) {
            throw new AggregateError([cause, cleanup], 'Workspace acquisition and cleanup failed');
          }
          throw cause;
        }
      })
  );
  connection.onRequest(
    'platform/admission/workspace/revalidate',
    (input: unknown, token: CancellationToken) =>
      execute(token, async (signal) => {
        await lease(input).revalidate(signal);
        return null;
      })
  );
  connection.onRequest(
    'platform/admission/workspace/release',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { leaseId } = Schema.decodeUnknownSync(PlatformWorkspaceLeaseSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        const borrowed = leases.get(leaseId);
        leases.delete(leaseId);
        await borrowed?.close();
        return null;
      })
  );
}
/** One private connection borrows existing owners; it constructs no platform store. */
export function serveDesktopPlatform(
  connection: MessageConnection,
  capabilities: DesktopPlatformCapabilities
): {
  close(): Promise<void>;
} {
  // The host's workspace borrows for its admitted runs, by the lease id it chose.
  const leases = new Map<string, DesktopWorkspaceBindingBorrow>();
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  const mcpStores = serveMainMcpStores(connection, capabilities.mcp);
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
  serveAdmissionReads(connection, execute, capabilities.admission, leases);
  connection.onRequest('platform/workspace/validate', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const request = Schema.decodeUnknownSync(PlatformWorkspaceBindingRequestSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      if (!capabilities.validateWorkspaceBinding) {
        throw new Error('Desktop has no live workspace binding owner');
      }
      await capabilities.validateWorkspaceBinding({
        binding: request.binding,
        signal,
        threadId: request.threadId,
      });
      signal.throwIfAborted();
      return { accepted: true };
    })
  );
  connection.onRequest('platform/workspace/root', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { rootId } = wireDecoder(
        Schema.Struct({ rootId: Schema.String.check(Schema.isMinCodePoints(1)) }),
        { errors: 'all', onExcessProperty: 'error' }
      )(input);
      if (!capabilities.resolveWorkspaceRoot) {
        throw new Error('Desktop has no live workspace root owner');
      }
      return await capabilities.resolveWorkspaceRoot(rootId);
    })
  );
  connection.onRequest(
    'platform/worktree/open-folder',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { path } = wireDecoder(PlatformWorktreeFolderSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        if (!capabilities.openWorktreeFolder) {
          throw new Error('Desktop cannot open worktrees as folders');
        }
        return await capabilities.openWorktreeFolder(path);
      })
  );
  connection.onRequest('platform/index/refresh', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { rootId } = wireDecoder(PlatformIndexRefreshSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      if (!capabilities.refreshWorkspaceIndex) {
        throw new Error('Desktop has no native workspace index owner');
      }
      await capabilities.refreshWorkspaceIndex(rootId);
      return null;
    })
  );
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
      const results = await Promise.allSettled([...leases.values()].map((lease) => lease.close()));
      const root = await Promise.allSettled([
        Promise.resolve().then(() => capabilities.closeRootCapabilities?.()),
      ]);
      const failures = [...results, ...root].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Desktop platform capability cleanup failed');
      }
      leases.clear();
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
