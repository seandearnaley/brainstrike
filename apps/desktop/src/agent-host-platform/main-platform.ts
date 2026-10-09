import { isDeepStrictEqual } from 'node:util';
import type { LocalLlmHostClient, RuntimeData } from '@brainstrike/agent/provider-runtime';
import {
  canonicalToolInputJsonSchema,
  type HostDelegation,
  type HostPlatform,
  type HostRunAdmissionRequest,
  type HostTool,
  validateCanonicalToolInput,
} from '@brainstrike/agent-host';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import { parseObservationalMemoryModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import { isHostExecutedNativeToolId } from './host-executed-tools';
import { type HostToolServiceCapabilities, serveHostToolServices } from './host-tool-services';
import { type DesktopLlmHostInference, serveLlmHostPort } from './llm-host-port';
import { type DesktopMcpPlatformCapabilities, serveMainMcpStores } from './mcp-main-stores';
import type { DesktopMemoryVectorSelection } from './memory-vector-selection';
import {
  PlatformLocalEmbeddingQuerySchema,
  PlatformLocalGenerationResultSchema,
  PlatformLocalGenerationSchema,
  PlatformLocalWarmupSchema,
  PlatformPolicySchema,
  PlatformProgressSchema,
  PlatformRunRequestSchema,
  type PlatformSelection,
  PlatformSelectionSchema,
  PlatformToolRequestSchema,
  PlatformWorkspaceBindingRequestSchema,
} from './platform-wire';

export interface DesktopPlatformSelection extends Omit<PlatformSelection, 'delegation' | 'tools'> {
  close(): Promise<void>;
  /** BST-1932: the personas and subagent limits this run may delegate with. */
  readonly delegation?: HostDelegation | undefined;
  /** The admitted roots revalidated against their live owners, for the host's shared tools. */
  freshWorkspaceRoots(): Promise<NonNullable<RuntimeData['workspaceRoots']>>;
  /** Main-only: an admitted local recall embedder's exact plan, never on the wire. */
  readonly localEmbedding?: DesktopMemoryVectorSelection['local'];
  revalidateWorkspace?(signal: AbortSignal): Promise<void>;
  readonly tools: Readonly<Record<string, HostTool>>;
}
export interface DesktopPlatformCapabilities {
  /** Join Main-owned Root borrowers before Core releases its canonical writer. */
  closeRootCapabilities?(): Promise<void>;
  /** Main-owned stores and services the agent host's own tools read (cap-tools). */
  readonly hostTools?: HostToolServiceCapabilities;
  /** The hidden llm-host renderer's inference, for the host's built-in local model. */
  readonly llmHost?: DesktopLlmHostInference;
  /** ADR-0007: Main's hidden embedding host, borrowed by a thread's admitted local recall. */
  readonly localEmbedding?: Pick<EmbeddingHostManager, 'queryEmbedding'>;
  /** ADR-0007: Main's hidden llm-host, borrowed by a thread's admitted local observer. */
  readonly localLlm?: LocalLlmHostClient;
  /** The Node host always composes its MCP runtime, which reaches these Main stores. */
  readonly mcp: DesktopMcpPlatformCapabilities;
  readConfiguration(request: HostRunAdmissionRequest): Promise<DesktopPlatformSelection>;
  readPermissionPolicy(
    threadId?: string
  ): PermissionToolGateSnapshot | Promise<PermissionToolGateSnapshot>;
  /** The live path of a mounted profile root; rejects an unknown root. */
  resolveWorkspaceRoot?(rootId: string): Promise<string>;
  readonly validateWorkspaceBinding?: HostPlatform['validateWorkspaceBinding'];
}

async function describePlatformSelection(
  captured: DesktopPlatformSelection
): Promise<PlatformSelection> {
  const tools = Object.fromEntries(
    await Promise.all(
      Object.entries(captured.tools).map(async ([name, tool]) => [
        name,
        {
          description: tool.description,
          identity: tool.identity,
          inputSchema: await canonicalToolInputJsonSchema(tool.inputSchema),
          ...(tool.interaction
            ? {
                interaction: {
                  kind: tool.interaction.kind,
                  resumeSchema: await canonicalToolInputJsonSchema(tool.interaction.resumeSchema),
                },
              }
            : {}),
          permissionToolId: tool.permissionToolId ?? name,
          risk: tool.risk,
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        },
      ])
    )
  );
  const {
    close: _close,
    freshWorkspaceRoots: _freshWorkspaceRoots,
    localEmbedding: _localEmbedding,
    revalidateWorkspace: _revalidateWorkspace,
    tools: _tools,
    ...configuration
  } = captured;
  return PlatformSelectionSchema.parse({ ...configuration, tools });
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

function desktopAdmissionRequest(
  request: ReturnType<typeof PlatformRunRequestSchema.parse>,
  signal: AbortSignal
): HostRunAdmissionRequest {
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
  const llmHost = capabilities.llmHost
    ? serveLlmHostPort(connection, capabilities.llmHost)
    : undefined;
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
    const task = Promise.resolve().then(() => work(controller.signal));
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
  // Only the admitted selection's own local observer may borrow the llm-host.
  const localObserver = (threadId: string, modelId: string): LocalLlmHostClient => {
    const observation = selection(threadId).memory.settings.observationalMemory;
    const target = observation.enabled
      ? parseObservationalMemoryModelTarget(observation.modelTarget)
      : undefined;
    if (target?.provider !== 'local' || target.model !== modelId) {
      throw new Error('Local generation is not part of this admitted thread selection');
    }
    if (!capabilities.localLlm) {
      throw new Error('This desktop has no local LLM host for the admitted local observer');
    }
    return capabilities.localLlm;
  };
  connection.onRequest('platform/llm/generate', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const { threadId, ...generation } = PlatformLocalGenerationSchema.parse(input);
      return PlatformLocalGenerationResultSchema.parse(
        await localObserver(threadId, generation.modelId).generate(generation, { signal })
      );
    })
  );
  connection.onRequest('platform/embedding/query', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const { query, threadId } = PlatformLocalEmbeddingQuerySchema.parse(input);
      const local = selection(threadId).localEmbedding;
      if (!local) {
        throw new Error('Local embedding is not part of this admitted thread selection');
      }
      if (!capabilities.localEmbedding) {
        throw new Error('This desktop has no embedding host for the admitted local recall');
      }
      const { workerPlan } = local;
      return {
        embedding: await capabilities.localEmbedding.queryEmbedding(
          {
            dimensions: workerPlan.dimensions,
            inferencePlan: workerPlan,
            modelId: workerPlan.modelId,
            modelKey: local.modelKey,
            query,
          },
          { signal }
        ),
      };
    })
  );
  connection.onRequest('platform/llm/warmup', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const { modelId, threadId } = PlatformLocalWarmupSchema.parse(input);
      await localObserver(threadId, modelId).warmup(modelId, { signal });
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
  connection.onRequest('platform/workspace/roots', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { threadId } = z.strictObject({ threadId: z.string().min(1) }).parse(input);
      return CliWorkspaceRootsSchema.parse(await selection(threadId).freshWorkspaceRoots());
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
        return await describePlatformSelection(captured);
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
  connection.onRequest(
    'platform/validate',
    (input: unknown, token: CancellationToken): Promise<unknown> =>
      execute(token, async () => {
        const request = z
          .strictObject({
            input: z.json(),
            resume: z.boolean().optional(),
            threadId: z.string().min(1),
            toolId: z.string().min(1),
          })
          .parse(input);
        const tool = selection(request.threadId).tools[request.toolId];
        if (!tool) {
          throw new Error('Platform validator is not admitted');
        }
        const schema = request.resume ? tool.interaction?.resumeSchema : tool.inputSchema;
        if (!schema) {
          throw new Error('Platform tool has no human interaction resume schema');
        }
        const result = await validateCanonicalToolInput(schema, request.input);
        return result.success ? { success: true, value: z.json().parse(result.value) } : result;
      })
  );
  connection.onRequest(
    'platform/execute',
    (input: unknown, token: CancellationToken): Promise<unknown> =>
      execute(token, async (signal) => {
        const request = PlatformToolRequestSchema.parse(input);
        const tool = selection(request.threadId).tools[request.toolId];
        if (!tool) {
          throw new Error('Platform executor is not admitted');
        }
        if (isHostExecutedNativeToolId(tool.permissionToolId ?? request.toolId)) {
          throw new Error('Host-executed native tools run in the agent host');
        }
        const output = await tool.execute(request.input, {
          ...(request.resumeData === undefined ? {} : { resumeData: request.resumeData }),
          runId: request.runId,
          signal,
          threadId: request.threadId,
          toolCallId: request.toolCallId,
          write: async (chunk) => {
            await connection.sendRequest(
              'platform/progress',
              PlatformProgressSchema.parse({
                chunk,
                runId: request.runId,
                threadId: request.threadId,
                toolCallId: request.toolCallId,
              })
            );
          },
        });
        return z.json().parse(output);
      })
  );
  connection.onRequest('platform/project', (input: unknown, token: CancellationToken) =>
    execute(token, async (): Promise<unknown> => {
      const request = z
        .strictObject({
          input: z.json(),
          output: z.json(),
          threadId: z.string().min(1),
          toolCallId: z.string().min(1),
          toolId: z.string().min(1),
        })
        .parse(input);
      const tool = selection(request.threadId).tools[request.toolId];
      if (!tool) {
        throw new Error('Platform projection is not admitted');
      }
      return (
        (await tool.toModelOutput?.({
          input: request.input,
          output: request.output,
          toolCallId: request.toolCallId,
        })) ?? null
      );
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
      llmHost?.dispose();
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
