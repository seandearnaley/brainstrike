import { isDeepStrictEqual } from 'node:util';
import type { LocalLlmHostProgress } from '@brainstrike/agent/local-llm';
import type { LocalLlmHostClient, RuntimeData } from '@brainstrike/agent/provider-runtime';
import type {
  HostDelegation,
  HostPlatform,
  HostRunAdmissionRequest,
  HostRunIntentRequest,
} from '@brainstrike/agent-host';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import { parseObservationalMemoryModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import type { PgliteLegacyMemory } from '@brainstrike/db';
import type { NativeChildObserver } from '@brainstrike/state-store/native-children';
import {
  type CancellationToken,
  ErrorCodes,
  type MessageConnection,
  ResponseError,
} from 'vscode-jsonrpc';
import { z } from 'zod';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import { serveHostRewindFiles } from './host-rewind-files';
import { type HostToolServiceCapabilities, serveHostToolServices } from './host-tool-services';
import { type DesktopWorkspaceSnapshots, serveHostTurnSnapshots } from './host-turn-snapshots';
import { serveLegacyMemory } from './legacy-memory-main';
import { type DesktopMcpPlatformCapabilities, serveMainMcpStores } from './mcp-main-stores';
import type { DesktopMemoryVectorSelection } from './memory-vector-selection';
import {
  PlatformEmbeddingQuerySchema,
  PlatformLocalGenerationResultSchema,
  PlatformLocalGenerationSchema,
  PlatformLocalWarmupSchema,
  PlatformMemoryReadinessSchema,
  PlatformNativeChildSchema,
  PlatformPolicySchema,
  PlatformRunIntentSchema,
  PlatformRunRequestSchema,
  type PlatformSelection,
  PlatformSelectionSchema,
  PlatformWorkspaceBindingRequestSchema,
} from './platform-wire';

export interface DesktopPlatformSelection extends Omit<PlatformSelection, 'delegation'> {
  close(): Promise<void>;
  /** BST-1932: the personas and subagent limits this run may delegate with. */
  readonly delegation?: HostDelegation | undefined;
  /** The admitted roots revalidated against their live owners, for the host's shared tools. */
  freshWorkspaceRoots(): Promise<NonNullable<RuntimeData['workspaceRoots']>>;
  /** Main-only: an admitted local recall embedder's exact plan, never on the wire. */
  readonly localEmbedding?: DesktopMemoryVectorSelection['local'];
  revalidateWorkspace?(signal: AbortSignal): Promise<void>;
}
export interface DesktopPlatformCapabilities {
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
  readConfiguration(request: HostRunAdmissionRequest): Promise<DesktopPlatformSelection>;
  /** Gap 17: the profile's legacy workspace memory, read once for the host's import. */
  readLegacyMemory(): Promise<PgliteLegacyMemory>;
  /** thread/memory/read: the same preconditions `readConfiguration` starts with, nothing acquired. */
  readMemoryReadiness?(
    request: HostRunIntentRequest
  ): Promise<z.input<typeof PlatformMemoryReadinessSchema>>;
  readPermissionPolicy(
    threadId?: string
  ): PermissionToolGateSnapshot | Promise<PermissionToolGateSnapshot>;
  /** The live path of a mounted profile root; rejects an unknown root. */
  resolveWorkspaceRoot?(rootId: string): Promise<string>;
  readonly validateWorkspaceBinding?: HostPlatform['validateWorkspaceBinding'];
  /** Legacy turns' shadow-git owner, which also snapshots each host run's turn. */
  readonly workspaceSnapshots?: DesktopWorkspaceSnapshots;
}

/** The selection as it crosses to the host: Main-only fields stay behind. */
function describePlatformSelection(captured: DesktopPlatformSelection): PlatformSelection {
  const {
    close: _close,
    freshWorkspaceRoots: _freshWorkspaceRoots,
    localEmbedding: _localEmbedding,
    revalidateWorkspace: _revalidateWorkspace,
    ...configuration
  } = captured;
  return PlatformSelectionSchema.parse(configuration);
}

async function rejectPlatformSelection(
  captured: DesktopPlatformSelection | undefined,
  onClosed: () => void,
  cause: unknown
): Promise<never> {
  if (captured) {
    try {
      await captured.close();
      onClosed();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Platform admission and cleanup failed');
    }
  }
  throw cause;
}

interface DesktopSelectionOwner {
  closing?: Promise<void>;
  readonly selection: DesktopPlatformSelection;
  readonly workspaceBinding?: HostRunAdmissionRequest['workspaceBinding'];
}

function desktopIntentRequest(
  request: ReturnType<typeof PlatformRunIntentSchema.parse>,
  signal: AbortSignal
): HostRunIntentRequest {
  return {
    ...(request.configuration ? { configuration: request.configuration } : {}),
    ...(request.snapshot ? { snapshot: request.snapshot } : {}),
    ...(request.workspaceBinding ? { workspaceBinding: request.workspaceBinding } : {}),
    modelId: request.modelId,
    ...(request.planMode ? { planMode: true } : {}),
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    signal,
    threadId: request.threadId,
  };
}

function desktopAdmissionRequest(
  request: ReturnType<typeof PlatformRunRequestSchema.parse>,
  signal: AbortSignal
): HostRunAdmissionRequest {
  return { ...desktopIntentRequest(request, signal), runId: request.runId };
}

/** One private connection borrows existing owners; it constructs no platform store. */
export function serveDesktopPlatform(
  connection: MessageConnection,
  capabilities: DesktopPlatformCapabilities
): { close(): Promise<void> } {
  const selections = new Map<string, DesktopSelectionOwner>();
  const admissions = new Set<string>();
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  const mcpStores = serveMainMcpStores(connection, capabilities.mcp);
  const legacyMemory = serveLegacyMemory(connection, capabilities.readLegacyMemory);
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
  const selection = (threadId: string): DesktopPlatformSelection => {
    const value = selections.get(threadId);
    if (!value || value.closing) {
      throw new Error('Platform thread has no admitted capabilities');
    }
    return value.selection;
  };
  // Only the admitted selection's own local chat model or observer may borrow the llm-host.
  const localModel = (threadId: string, modelId: string): LocalLlmHostClient => {
    const admitted = selection(threadId);
    const observation = admitted.memory.settings.observationalMemory;
    const observer = observation.enabled
      ? parseObservationalMemoryModelTarget(observation.modelTarget)
      : undefined;
    const chat = admitted.configuration;
    if (
      !(
        (chat.provider === 'local' && chat.model === modelId) ||
        (observer?.provider === 'local' && observer.model === modelId)
      )
    ) {
      throw new Error('Local generation is not part of this admitted thread selection');
    }
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
      const { requestId, threadId, ...generation } = PlatformLocalGenerationSchema.parse(input);
      return PlatformLocalGenerationResultSchema.parse(
        await localModel(threadId, generation.modelId).generate(generation, {
          onProgress: relayProgress(requestId),
          signal,
        })
      );
    })
  );
  connection.onRequest('platform/embedding/query', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const parsed = PlatformEmbeddingQuerySchema.parse(input);
      const admitted = selection(parsed.threadId);
      const embeddings = capabilities.localEmbedding;
      if (!embeddings) {
        throw new Error('This desktop has no embedding host for host threads');
      }
      if ('request' in parsed) {
        // A retrieval tool's query, for a thread with admitted capabilities.
        return await embeddings.queryEmbedding(parsed.request, { signal });
      }
      const local = admitted.localEmbedding;
      if (!local) {
        throw new Error('Local embedding is not part of this admitted thread selection');
      }
      const { workerPlan } = local;
      return await embeddings.queryEmbedding(
        {
          dimensions: workerPlan.dimensions,
          inferencePlan: workerPlan,
          modelId: workerPlan.modelId,
          modelKey: local.modelKey,
          query: parsed.query,
        },
        { signal }
      );
    })
  );
  connection.onRequest('platform/llm/warmup', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const { modelId, requestId, threadId } = PlatformLocalWarmupSchema.parse(input);
      await localModel(threadId, modelId).warmup(modelId, {
        onProgress: relayProgress(requestId),
        signal,
      });
      return null;
    })
  );
  connection.onRequest('platform/policy', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { threadId } = z.strictObject({ threadId: z.string().min(1).optional() }).parse(input);
      return PlatformPolicySchema.parse(await capabilities.readPermissionPolicy(threadId));
    })
  );
  connection.onRequest('platform/workspace/validate', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const request = PlatformWorkspaceBindingRequestSchema.parse(input);
      if (!capabilities.validateWorkspaceBinding) {
        throw new Error('Desktop has no live workspace binding owner');
      }
      const captured = selections.get(request.threadId);
      if (
        captured?.selection.revalidateWorkspace &&
        isDeepStrictEqual(captured.workspaceBinding, request.binding)
      ) {
        await captured.selection.revalidateWorkspace(signal);
      } else {
        await capabilities.validateWorkspaceBinding({ ...request, signal });
      }
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
  serveHostToolServices(connection, execute, selection, capabilities.hostTools);
  serveHostTurnSnapshots(
    connection,
    execute,
    (threadId) => selection(threadId).freshWorkspaceRoots(),
    capabilities.workspaceSnapshots
  );
  serveHostRewindFiles(connection, execute, capabilities);
  connection.onRequest('platform/workspace/roots', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { threadId } = z.strictObject({ threadId: z.string().min(1) }).parse(input);
      return CliWorkspaceRootsSchema.parse(await selection(threadId).freshWorkspaceRoots());
    })
  );
  // Read-only: no selection is registered, so it never conflicts with a run's.
  connection.onRequest(
    'platform/memory/readiness',
    // The explicit result type keeps vscode-jsonrpc from narrowing the union to one member.
    (input: unknown, token: CancellationToken): Promise<unknown> =>
      execute(token, async (signal) => {
        const read = capabilities.readMemoryReadiness;
        if (!read) {
          throw new Error('Desktop memory readiness is unavailable');
        }
        const request = PlatformRunIntentSchema.parse(input);
        return PlatformMemoryReadinessSchema.parse(
          await read(desktopIntentRequest(request, signal))
        );
      })
  );
  connection.onRequest('platform/admit', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const request = PlatformRunRequestSchema.parse(input);
      if (selections.has(request.threadId) || admissions.has(request.threadId)) {
        throw new Error('Platform thread already owns a selection');
      }
      admissions.add(request.threadId);
      let captured: DesktopPlatformSelection | undefined;
      try {
        const borrowed = await capabilities.readConfiguration(
          desktopAdmissionRequest(request, signal)
        );
        const owner: DesktopSelectionOwner = {
          ...(request.workspaceBinding ? { workspaceBinding: request.workspaceBinding } : {}),
          selection: {
            ...borrowed,
            close: () => (owner.closing ??= borrowed.close()),
          },
        };
        captured = owner.selection;
        selections.set(request.threadId, owner);
        signal.throwIfAborted();
        return describePlatformSelection(captured);
      } catch (cause) {
        return await rejectPlatformSelection(
          captured,
          () => {
            selections.delete(request.threadId);
          },
          cause
        );
      } finally {
        admissions.delete(request.threadId);
      }
    })
  );
  connection.onRequest('platform/release', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { threadId } = z.strictObject({ threadId: z.string().min(1) }).parse(input);
      const captured = selections.get(threadId);
      if (captured) {
        await captured.selection.close();
        selections.delete(threadId);
      }
    })
  );
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(async () => {
      for (const controller of controllers) {
        controller.abort(new Error('Desktop platform is closing'));
      }
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
      mcpStores.close();
      legacyMemory.close();
      const results = await Promise.allSettled(
        [...selections.values()].map((value) => value.selection.close())
      );
      const root = await Promise.allSettled([
        Promise.resolve().then(() => capabilities.closeRootCapabilities?.()),
      ]);
      const failures = [...results, ...root].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Desktop platform capability cleanup failed');
      }
      selections.clear();
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
