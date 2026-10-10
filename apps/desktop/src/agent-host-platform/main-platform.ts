import type { LocalLlmHostProgress } from '@brainstrike/agent/local-llm';
import type { LocalLlmHostClient } from '@brainstrike/agent/provider-runtime';
import type { HostPlatform } from '@brainstrike/agent-host';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import type { NativeChildObserver } from '@brainstrike/state-store/native-children';
import {
  type CancellationToken,
  ErrorCodes,
  type MessageConnection,
  ResponseError,
} from 'vscode-jsonrpc';
import { z } from 'zod';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import type { DesktopAdmissionReads } from './desktop-run-admission';
import type { DesktopWorkspaceBindingBorrow } from './desktop-workspace-binding';
import { serveHostRewindFiles } from './host-rewind-files';
import { type HostToolServiceCapabilities, serveHostToolServices } from './host-tool-services';
import { type DesktopWorkspaceSnapshots, serveHostTurnSnapshots } from './host-turn-snapshots';
import { type DesktopMcpPlatformCapabilities, serveMainMcpStores } from './mcp-main-stores';
import {
  PlatformCatalogModelResultSchema,
  PlatformCatalogModelSchema,
  PlatformEmbeddingQuerySchema,
  PlatformLocalGenerationResultSchema,
  PlatformLocalGenerationSchema,
  PlatformLocalWarmupSchema,
  PlatformMemoryVectorsResultSchema,
  PlatformMemoryVectorsSchema,
  PlatformNativeChildSchema,
  PlatformObserverCandidatesResultSchema,
  PlatformObserverCandidatesSchema,
  PlatformWorkspaceAcquireResultSchema,
  PlatformWorkspaceAcquireSchema,
  PlatformWorkspaceBindingRequestSchema,
  PlatformWorkspaceLeaseSchema,
} from './platform-wire';

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
  /**
   * ADR-0007: Main's hidden embedding host, borrowed by an admitted thread's
   * local recall or retrieval tools through `platform/embedding/query`.
   */
  readonly localEmbedding?: Pick<EmbeddingHostManager, 'queryEmbedding'>;
  /** ADR-0007: Main's hidden llm-host, borrowed by a thread's admitted local chat model or observer. */
  readonly localLlm?: LocalLlmHostClient;
  /** The Node host always composes its MCP runtime, which reaches these Main stores. */
  readonly mcp: DesktopMcpPlatformCapabilities;
  /** ADR-0017: Main's supervisor of the native processes the host reports starting. */
  readonly nativeChildren?: NativeChildObserver;
  /** The live path of a mounted profile root; rejects an unknown root. */
  resolveWorkspaceRoot?(rootId: string): Promise<string>;
  readonly validateWorkspaceBinding?: HostPlatform['validateWorkspaceBinding'];
  /** Legacy turns' shadow-git owner, which also snapshots each host run's turn. */
  readonly workspaceSnapshots?: DesktopWorkspaceSnapshots;
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
    const borrowed = leases.get(PlatformWorkspaceLeaseSchema.parse(input).leaseId);
    if (!borrowed) {
      throw new Error('The workspace lease is not held');
    }
    return borrowed;
  };
  connection.onRequest(
    'platform/admission/catalog-model',
    (input: unknown, token: CancellationToken) =>
      execute(token, async (signal) =>
        PlatformCatalogModelResultSchema.parse(
          await reads.catalogModel(PlatformCatalogModelSchema.parse(input), signal)
        )
      )
  );
  connection.onRequest('platform/admission/observers', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) =>
      PlatformObserverCandidatesResultSchema.parse(
        await reads.enabledObservers(
          PlatformObserverCandidatesSchema.parse(input).candidates,
          signal
        )
      )
    )
  );
  connection.onRequest(
    'platform/admission/memory-vectors',
    (input: unknown, token: CancellationToken) =>
      execute(token, async (signal) =>
        PlatformMemoryVectorsResultSchema.parse(
          (await reads.memoryVectors(PlatformMemoryVectorsSchema.parse(input).settings, signal)) ??
            null
        )
      )
  );
  connection.onRequest('platform/admission/roots', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      z.strictObject({}).parse(input);
      return CliWorkspaceRootsSchema.parse(await reads.liveWorkspaceRoots(signal));
    })
  );
  connection.onRequest(
    'platform/admission/worktrees',
    // The explicit result type keeps vscode-jsonrpc from narrowing it to a boolean literal.
    (input: unknown, token: CancellationToken): Promise<unknown> =>
      execute(token, async (signal) => {
        z.strictObject({}).parse(input);
        return z.boolean().parse(await reads.worktreesAvailable(signal));
      })
  );
  connection.onRequest(
    'platform/admission/workspace/acquire',
    (input: unknown, token: CancellationToken) =>
      execute(token, async (signal) => {
        const { binding, leaseId, threadId } = PlatformWorkspaceAcquireSchema.parse(input);
        if (leases.has(leaseId)) {
          throw new Error('The workspace lease is already held');
        }
        const borrowed = await reads.acquireWorkspace({ binding, signal, threadId });
        try {
          // A borrow the host stopped waiting for, or whose roots cannot cross, is returned.
          signal.throwIfAborted();
          const acquired = PlatformWorkspaceAcquireResultSchema.parse({
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
        const { leaseId } = PlatformWorkspaceLeaseSchema.parse(input);
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
): { close(): Promise<void> } {
  // The host's workspace borrows for its admitted runs, by the lease id it chose.
  const leases = new Map<string, DesktopWorkspaceBindingBorrow>();
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  const mcpStores = serveMainMcpStores(connection, capabilities.mcp);
  const nativeChildren = capabilities.nativeChildren;
  if (nativeChildren) {
    connection.onNotification('platform/native-child/started', (input: unknown) =>
      nativeChildren.started(PlatformNativeChildSchema.parse(input))
    );
    connection.onNotification('platform/native-child/exited', (input: unknown) =>
      nativeChildren.exited(PlatformNativeChildSchema.parse(input))
    );
  }
  let closing: Promise<void> | undefined;
  const execute = <T>(
    token: CancellationToken,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    if (closing) {
      return Promise.reject(new Error('Desktop platform capability is closing'));
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
        // vscode-jsonrpc reports a plain Error as "Request <method> failed with
        // message: ..."; the host receives the platform's own message instead,
        // a reason the composer can show (thread/memory/read).
        throw cause instanceof ResponseError
          ? cause
          : new ResponseError(
              ErrorCodes.InternalError,
              cause instanceof Error ? cause.message : String(cause)
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
  connection.onRequest('platform/ready', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      z.strictObject({}).parse(input);
      signal.throwIfAborted();
      return null;
    })
  );
  // ADR-0007: the host decides which admitted model may borrow the llm-host.
  const localLlm = (): LocalLlmHostClient => {
    if (!capabilities.localLlm) {
      throw new Error('This desktop has no local LLM host for the admitted local model');
    }
    return capabilities.localLlm;
  };
  // Cumulative snapshots stream the borrowed generation; a lost one never fails it.
  const relayProgress =
    (requestId: string) =>
    (progress: LocalLlmHostProgress): void => {
      connection
        .sendNotification('platform/llm/progress', { progress, requestId })
        .catch(() => undefined);
    };
  connection.onRequest('platform/llm/generate', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const { requestId, ...generation } = PlatformLocalGenerationSchema.parse(input);
      return PlatformLocalGenerationResultSchema.parse(
        await localLlm().generate(generation, {
          onProgress: relayProgress(requestId),
          signal,
        })
      );
    })
  );
  connection.onRequest('platform/embedding/query', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const { request } = PlatformEmbeddingQuerySchema.parse(input);
      const embeddings = capabilities.localEmbedding;
      if (!embeddings) {
        throw new Error('This desktop has no embedding host for host threads');
      }
      // A retrieval tool's query or an admitted local recall embedder's, as the host sent it.
      return await embeddings.queryEmbedding(request, { signal });
    })
  );
  connection.onRequest('platform/llm/warmup', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const { modelId, requestId } = PlatformLocalWarmupSchema.parse(input);
      await localLlm().warmup(modelId, {
        onProgress: relayProgress(requestId),
        signal,
      });
      return null;
    })
  );
  serveAdmissionReads(connection, execute, capabilities.admission, leases);
  connection.onRequest('platform/workspace/validate', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const request = PlatformWorkspaceBindingRequestSchema.parse(input);
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
      const { rootId } = z.strictObject({ rootId: z.string().min(1) }).parse(input);
      if (!capabilities.resolveWorkspaceRoot) {
        throw new Error('Desktop has no live workspace root owner');
      }
      return await capabilities.resolveWorkspaceRoot(rootId);
    })
  );
  serveHostToolServices(connection, execute, capabilities.hostTools);
  serveHostTurnSnapshots(connection, execute, capabilities.workspaceSnapshots);
  serveHostRewindFiles(connection, execute, capabilities);
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
  connection.onRequest('platform/close', close);
  connection.listen();
  return {
    close: disconnect,
  };
}
