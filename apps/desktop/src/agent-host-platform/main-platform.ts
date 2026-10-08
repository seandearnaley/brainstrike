import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import {
  canonicalToolInputJsonSchema,
  type HostRunAdmissionRequest,
  type HostTool,
  validateCanonicalToolInput,
} from '@brainstrike/agent-host';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import { parseObservationalMemoryModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { serveMainMcpPlatformTransport } from './mcp-platform-transport';
import { encodePlatformAuth } from './platform-auth';
import {
  PlatformPolicySchema,
  PlatformProgressSchema,
  PlatformRunRequestSchema,
  type PlatformSelection,
  PlatformSelectionSchema,
  PlatformToolRequestSchema,
} from './platform-wire';
import { serveProviderFetchTransport } from './provider-fetch-transport';

export interface DesktopPlatformSelection extends Omit<PlatformSelection, 'tools'> {
  close(): Promise<void>;
  readonly tools: Readonly<Record<string, HostTool>>;
}
export interface DesktopPlatformCapabilities {
  /** Join Main-owned Root borrowers before Core releases its canonical writer. */
  closeRootCapabilities?(): Promise<void>;
  readConfiguration(request: HostRunAdmissionRequest): Promise<DesktopPlatformSelection>;
  readPermissionPolicy(
    threadId?: string
  ): PermissionToolGateSnapshot | Promise<PermissionToolGateSnapshot>;
  resolveProviderAuth(provider: string): Promise<ProviderAuthInput | undefined>;
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
          ...(tool.mcpAuthority ? { mcpAuthority: tool.mcpAuthority } : {}),
          ...(tool.mcpBinding ? { mcpBinding: tool.mcpBinding } : {}),
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
  const { close: _close, tools: _tools, ...configuration } = captured;
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
}

async function closeDesktopProviderSelection(
  borrowed: DesktopPlatformSelection,
  auth: readonly Promise<ProviderAuthInput | undefined>[],
  closeFetch: () => Promise<void>,
  onClosed: () => void
): Promise<void> {
  // A cancelled requester can detach while the original credential-owner
  // lookup is still settling. Join it before releasing its captured selection.
  await Promise.allSettled(auth);
  const failures: unknown[] = [];
  for (const close of [closeFetch, () => borrowed.close()]) {
    try {
      await close();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Desktop provider selection cleanup failed');
  }
  onClosed();
}

/** One private connection borrows existing owners; it constructs no platform store. */
export function serveDesktopPlatform(
  connection: MessageConnection,
  capabilities: DesktopPlatformCapabilities
): { close(): Promise<void> } {
  const selections = new Map<string, DesktopSelectionOwner>();
  const authScopes = new Map<
    string,
    Map<
      string,
      { readonly original: Promise<ProviderAuthInput | undefined>; value?: ProviderAuthInput }
    >
  >();
  const admissions = new Set<string>();
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  const mcp = serveMainMcpPlatformTransport(connection, (work) => {
    pending.add(work);
    const done = (): void => {
      pending.delete(work);
    };
    work.then(done, done);
  });
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
  const providerFetch = serveProviderFetchTransport(connection, {
    getFetch: ({ threadId, provider }) => {
      selection(threadId);
      const auth = authScopes.get(threadId)?.get(provider)?.value;
      if (auth?.kind !== 'custom_fetch') {
        throw new Error('Provider fetch has no captured auth capability for this admitted thread');
      }
      return auth.fetch;
    },
  });
  const resolveAuth = (
    threadId: string,
    provider: string
  ): Promise<ProviderAuthInput | undefined> => {
    const admitted = selection(threadId);
    const observation = admitted.memory.settings.observationalMemory;
    if (
      provider !== admitted.configuration.provider &&
      (!observation.enabled ||
        parseObservationalMemoryModelTarget(observation.modelTarget).provider !== provider)
    ) {
      throw new Error('Provider auth is not part of this admitted thread selection');
    }
    let scope = authScopes.get(threadId);
    if (!scope) {
      scope = new Map();
      authScopes.set(threadId, scope);
    }
    let captured = scope.get(provider);
    if (!captured) {
      const next: {
        readonly original: Promise<ProviderAuthInput | undefined>;
        value?: ProviderAuthInput;
      } = { original: Promise.resolve().then(() => capabilities.resolveProviderAuth(provider)) };
      next.original.then(
        (value) => {
          if (value !== undefined) {
            next.value = value;
          }
        },
        () => undefined
      );
      captured = next;
      scope.set(provider, captured);
    }
    return captured.original;
  };
  connection.onRequest('platform/policy', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { threadId } = z.strictObject({ threadId: z.string().min(1).optional() }).parse(input);
      return PlatformPolicySchema.parse(await capabilities.readPermissionPolicy(threadId));
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
        const borrowed = await capabilities.readConfiguration({
          ...(request.configuration ? { configuration: request.configuration } : {}),
          ...(request.snapshot ? { snapshot: request.snapshot } : {}),
          modelId: request.modelId,
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          signal,
          threadId: request.threadId,
        });
        const owner: DesktopSelectionOwner = {
          selection: {
            ...borrowed,
            close: () =>
              (owner.closing ??= closeDesktopProviderSelection(
                borrowed,
                [...(authScopes.get(request.threadId)?.values() ?? [])].map(
                  (auth) => auth.original
                ),
                () => providerFetch.release(request.threadId),
                () => authScopes.delete(request.threadId)
              )),
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
    'platform/auth',
    (input: unknown, token: CancellationToken): Promise<unknown> =>
      execute(token, async () => {
        const { provider, threadId } = z
          .strictObject({ provider: z.string().min(1), threadId: z.string().min(1) })
          .parse(input);
        const auth = await resolveAuth(threadId, provider);
        // Closures are never dropped or silently replaced at this private boundary.
        return encodePlatformAuth(auth);
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
        try {
          const output = await tool.execute(request.input, {
            ...(request.resumeData === undefined ? {} : { resumeData: request.resumeData }),
            runId: request.runId,
            signal,
            threadId: request.threadId,
            toolCallId: request.toolCallId,
            ...(tool.mcpBinding ? { mcp: mcp.execution(request, signal) } : {}),
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
        } finally {
          mcp.release(request);
        }
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
      mcp.close();
      const results = await Promise.allSettled(
        [...selections.values()].map((value) => value.selection.close())
      );
      const root = await Promise.allSettled([
        providerFetch.close(),
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
