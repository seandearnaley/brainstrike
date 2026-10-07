import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import {
  canonicalToolInputJsonSchema,
  type HostRunAdmissionRequest,
  type HostTool,
  validateCanonicalToolInput,
} from '@brainstrike/agent-host';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { encodePlatformAuth } from './platform-auth';
import {
  PlatformPolicySchema,
  PlatformProgressSchema,
  PlatformRunRequestSchema,
  type PlatformSelection,
  PlatformSelectionSchema,
  PlatformToolRequestSchema,
} from './platform-wire';

export interface DesktopPlatformSelection extends Omit<PlatformSelection, 'tools'> {
  close(): Promise<void>;
  readonly tools: Readonly<Record<string, HostTool>>;
}
export interface DesktopPlatformCapabilities {
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
          inputSchema: await canonicalToolInputJsonSchema(tool.inputSchema),
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

/** One private connection borrows existing owners; it constructs no platform store. */
export function serveDesktopPlatform(
  connection: MessageConnection,
  capabilities: DesktopPlatformCapabilities
): { close(): Promise<void> } {
  const selections = new Map<string, DesktopPlatformSelection>();
  const admissions = new Set<string>();
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
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
    if (!value) {
      throw new Error('Platform thread has no admitted capabilities');
    }
    return value;
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
        let joined: Promise<void> | undefined;
        captured = { ...borrowed, close: () => (joined ??= borrowed.close()) };
        selections.set(request.threadId, captured);
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
        await captured.close();
        selections.delete(threadId);
      }
    })
  );
  connection.onRequest(
    'platform/validate',
    (input: unknown, token: CancellationToken): Promise<unknown> =>
      execute(token, async () => {
        const request = z
          .strictObject({ input: z.json(), threadId: z.string().min(1), toolId: z.string().min(1) })
          .parse(input);
        const tool = selection(request.threadId).tools[request.toolId];
        if (!tool) {
          throw new Error('Platform validator is not admitted');
        }
        const result = await validateCanonicalToolInput(tool.inputSchema, request.input);
        return result.success ? { success: true, value: z.json().parse(result.value) } : result;
      })
  );
  connection.onRequest(
    'platform/auth',
    (input: unknown, token: CancellationToken): Promise<unknown> =>
      execute(token, async () => {
        const { provider } = z.strictObject({ provider: z.string().min(1) }).parse(input);
        const auth = await capabilities.resolveProviderAuth(provider);
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
        const output = await tool.execute(request.input, {
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
      const results = await Promise.allSettled(
        [...selections.values()].map((value) => value.close())
      );
      const failures = results.flatMap((result) =>
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
