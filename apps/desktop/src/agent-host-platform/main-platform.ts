import { toBoundaryResponseError } from '@brainstrike/agent-host/boundary-wire';
import type { CredentialCipher } from '@brainstrike/agent-host/credential-contract';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import { BoundaryFailureError, fault } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { createLogger, error as logError, fatal as logFatal } from '@brainstrike/logging';
import type { NativeChildObserver } from '@brainstrike/state-store/native-children';
import { Schema } from 'effect';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { hostedQueryEmbedding } from '../hosted-embeddings';
import type { LifecycleDelaySeam } from '../lifecycle-delay-seam';
import { nativeIndexBoundaryFailure } from '../native-index-boundary-failure';
import type { DesktopAdmissionReads } from './desktop-run-admission';
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
  PlatformCredentialOpenSchema,
  PlatformCredentialSealSchema,
  PlatformDiagnosticRecordSchema,
  PlatformEmbeddingQuerySchema,
  PlatformIndexRefreshSchema,
  PlatformMemoryVectorsResultSchema,
  PlatformMemoryVectorsSchema,
  PlatformNativeChildSchema,
  PlatformObserverCandidatesResultSchema,
  PlatformObserverCandidatesSchema,
  PlatformRootsChangedSchema,
  PlatformShowFolderSchema,
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
  readonly admission: Omit<DesktopAdmissionReads, 'acquireWorkspace'>;
  /**
   * Main-owned Root borrowers close with the host's platform. `closing`: Core asked
   * (`platform/close`) and releases its canonical writer once this resolves, so they are joined.
   * `gone`: the host's connection closed without asking, so no writer waits to be released.
   */
  closeRootCapabilities?(host: 'closing' | 'gone'): Promise<void>;
  /** ADR-0029: Main's safeStorage, lent to the host's sealed credential file. */
  readonly credentialCipher?: CredentialCipher;
  /** Main-owned stores and services the agent host's own tools read (cap-tools). */
  readonly hostTools?: HostToolServiceCapabilities;
  /** Main's E2E delay seam; `platform-ready` delays Main's answer to the host's readiness check. */
  readonly lifecycleDelays?: Pick<LifecycleDelaySeam, 'delay'>;
  /** The Node host always composes its MCP runtime, which reaches these Main stores. */
  readonly mcp: DesktopMcpPlatformCapabilities;
  /** ADR-0017: Main's supervisor of the native processes the host reports starting. */
  readonly nativeChildren?: NativeChildObserver;
  /** ADR-0029 stage 4: Main's native folder picker; null when the person cancelled. */
  pickWorkspaceFolder?(): Promise<string | null>;
  /** Main's native index rescans a root after a rewind restored it on disk. */
  refreshWorkspaceIndex?(rootId: string): Promise<void>;
  /** The live path of a mounted profile root; rejects an unknown root. */
  resolveWorkspaceRoot?(rootId: string): Promise<string>;
  /**
   * ADR-0028 step 3: the host opened a worktree an agent created as a workspace
   * folder; the focused window shows it, as for any folder Main opens.
   */
  showWorkspaceFolder?(path: string): void;
  /**
   * The host's open folders changed: the native index re-reads them, and the OS recent
   * documents and File > Open Recent follow the recent-folders ledger.
   */
  workspaceRootsChanged?(change: {
    readonly grantedPath?: string;
    readonly recentPaths: readonly string[];
  }): void;
}
type Execute = <T>(
  token: CancellationToken,
  work: (signal: AbortSignal) => Promise<T>
) => Promise<T>;
/** BST-1930 stage e: the reads a host-composed admission makes of Main's facts. */
function serveAdmissionReads(
  connection: MessageConnection,
  execute: Execute,
  reads: DesktopPlatformCapabilities['admission']
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
      return await refusalOutcome(() => hostedQueryEmbedding(request, signal));
    })
  );
  const cipher = (): CredentialCipher => {
    if (!capabilities.credentialCipher) {
      throw new Error('Desktop has no credential cipher to lend');
    }
    return capabilities.credentialCipher;
  };
  connection.onRequest('platform/credentials/seal', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { plaintext } = wireDecoder(PlatformCredentialSealSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      return await cipher().seal(plaintext);
    })
  );
  connection.onRequest('platform/credentials/open', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { sealed } = wireDecoder(PlatformCredentialOpenSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      return await cipher().open(sealed);
    })
  );
  serveAdmissionReads(connection, execute, capabilities.admission);
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
  // ADR-0029 stage 4: the host owns the open folders; Main keeps the picker and the windows.
  connection.onRequest(
    'platform/workspace/pick-folder',
    (_input: unknown, token: CancellationToken): Promise<unknown> =>
      execute(token, async () => {
        if (!capabilities.pickWorkspaceFolder) {
          throw new Error('Desktop has no folder picker');
        }
        const picked = await capabilities.pickWorkspaceFolder();
        return picked === null ? { cancelled: true } : { path: picked };
      })
  );
  connection.onRequest(
    'platform/workspace/roots-changed',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const change = wireDecoder(PlatformRootsChangedSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        capabilities.workspaceRootsChanged?.(change);
        return null;
      })
  );
  connection.onRequest(
    'platform/workspace/show-folder',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { path } = wireDecoder(PlatformShowFolderSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        if (!capabilities.showWorkspaceFolder) {
          throw new Error('Desktop cannot show a folder in a window');
        }
        capabilities.showWorkspaceFolder(path);
        return null;
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
  const close = (host: 'closing' | 'gone'): Promise<void> => {
    closing ??= Promise.resolve().then(async () => {
      for (const controller of controllers) {
        controller.abort(new Error('Desktop platform is closing'));
      }
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
      mcpStores.close();
      const root = await Promise.allSettled([
        Promise.resolve().then(() => capabilities.closeRootCapabilities?.(host)),
      ]);
      const failures = root.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Desktop platform capability cleanup failed');
      }
    });
    return closing;
  };
  const disconnect = (): Promise<void> => {
    const joined = close('gone');
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
    void close('gone').catch(() => undefined);
  });
  // The host keeps its Root when this fails, so the failure is logged here with
  // every inner cause, under the correlation id the host's fault carries (BST-2192).
  connection.onRequest('platform/close', () =>
    close('closing').catch((cause: unknown) => {
      throw toBoundaryResponseError(cause, (message, fields) => logger.error(message, fields));
    })
  );
  connection.listen();
  return {
    close: disconnect,
  };
}
