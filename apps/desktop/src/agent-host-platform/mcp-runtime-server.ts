import { readMcpCreatedTaskResult } from '@brainstrike/agent';
import { mcpToolRegistry } from '@brainstrike/agent/mcp-client';
import {
  parseMcpElicitationSettlement,
  parseMcpExtensionEnablement,
  parseMcpHostControlRequest,
  parseMcpHostOperation,
} from '@brainstrike/assistant-contract';
import { parseMcpConfigValue } from '@brainstrike/assistant-contract/mcp-config';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import type { McpHostRuntime } from '../mcp/node-host-runtime';
import {
  MCP_RUNTIME_METHODS,
  MCP_RUNTIME_NOTIFICATIONS,
  type McpToolRegistryState,
  McpToolRegistryStateSchema,
  respond,
} from './mcp-runtime-wire';

function tokenSignal(token: CancellationToken): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new DOMException('Cancelled by Main', 'AbortError'));
  const subscription = token.onCancellationRequested(cancel);
  if (token.isCancellationRequested) {
    cancel();
  }
  return { dispose: () => subscription.dispose(), signal: controller.signal };
}

/** Replace this process's tool registry with exactly the state Settings published. */
export function applyMcpToolRegistryState(state: McpToolRegistryState): void {
  mcpToolRegistry.clear();
  const disabled: string[] = [];
  for (const [serverName, tools] of Object.entries(state)) {
    mcpToolRegistry.register(
      serverName,
      Object.fromEntries(
        tools.map((tool) => [
          tool.id,
          {
            ...(tool.description === undefined ? {} : { description: tool.description }),
            ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
          },
        ])
      )
    );
    disabled.push(...tools.filter((tool) => !tool.enabled).map((tool) => tool.id));
  }
  if (disabled.length > 0) {
    mcpToolRegistry.disableTools(disabled);
  }
}

/**
 * Serve the Node host's one MCP runtime to Main's renderer surfaces over the
 * private connection (interim until c5 makes them public host methods). Main
 * never owns a second runtime, session or task authority.
 */
export function serveMcpRuntimeToMain(
  connection: MessageConnection,
  runtime: McpHostRuntime
): { close(): void } {
  const invocations = new Map<string, () => void>();
  let detachElicitation: (() => void) | undefined;
  const notify = (method: string, payload: unknown): void => {
    // Main may already be gone during shutdown; the runtime does not depend on delivery.
    void connection.sendNotification(method, payload).catch(() => undefined);
  };
  const unwatch = runtime.host.watch({}, (event) => notify(MCP_RUNTIME_NOTIFICATIONS.watch, event));
  const unsubscribeTasks = runtime.taskHost.subscribe((task) =>
    notify(MCP_RUNTIME_NOTIFICATIONS.tasksChanged, { task, tasks: runtime.taskHost.list().tasks })
  );
  const unobserveFinalized = runtime.elicitationPresenter.observeFinalized((event) =>
    notify(MCP_RUNTIME_NOTIFICATIONS.elicitationFinalized, event)
  );
  const handlers = [
    connection.onRequest(MCP_RUNTIME_METHODS.snapshot, () =>
      respond(() => ({
        extensionPreferences: runtime.mcpExtensionPreferences,
        snapshot: runtime.host.snapshot(),
        tasks: runtime.taskHost.list().tasks,
      }))
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.control, (input: unknown) =>
      respond(() => runtime.host.control(parseMcpHostControlRequest(input)))
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.config, (input: unknown) =>
      respond(() => runtime.replaceResolvedConfig(parseMcpConfigValue(input).config))
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.extensions, (input: unknown) =>
      respond(() => runtime.setMcpExtensionPreferences(parseMcpExtensionEnablement(input)))
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.tools, (input: unknown) =>
      respond(() => {
        applyMcpToolRegistryState(McpToolRegistryStateSchema.parse(input));
      })
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.invoke, (input: unknown, token: CancellationToken) =>
      respond(async () => {
        const request = z
          .strictObject({ invocationId: z.uuid(), operation: z.unknown() })
          .parse(input);
        const scope = tokenSignal(token);
        invocations.set(request.invocationId, scope.dispose);
        try {
          return await runtime.host.invoke(parseMcpHostOperation(request.operation), {
            onProgress: (progress) =>
              notify(MCP_RUNTIME_NOTIFICATIONS.progress, {
                invocationId: request.invocationId,
                progress,
              }),
            signal: scope.signal,
          });
        } finally {
          invocations.delete(request.invocationId);
          scope.dispose();
        }
      })
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.tasksList, () =>
      respond(() => runtime.taskHost.list())
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.tasksAct, (input: unknown) =>
      respond(() => runtime.taskHost.act(input))
    ),
    connection.onRequest(
      MCP_RUNTIME_METHODS.tasksTrack,
      (input: unknown, token: CancellationToken) =>
        respond(async () => {
          // Main's Apps calls carry no host execution; the lifecycle validates the result.
          const request = z
            .strictObject({
              configuredServerId: z.string().min(1),
              result: z.json(),
              toolName: z.string().min(1),
            })
            .parse(input);
          const result = readMcpCreatedTaskResult(request.result);
          if (!result) {
            throw new Error('MCP task tracking requires a created-task result');
          }
          const scope = tokenSignal(token);
          try {
            return await runtime.taskHost.track(
              {
                configuredServerId: request.configuredServerId,
                result,
                toolName: request.toolName,
              },
              scope.signal
            );
          } finally {
            scope.dispose();
          }
        })
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.elicitationAttach, () =>
      respond(() => {
        if (detachElicitation) {
          throw new Error('Main already presents local MCP input');
        }
        detachElicitation = runtime.elicitationPresenter.attach((presentation) =>
          notify(MCP_RUNTIME_NOTIFICATIONS.elicitationRequested, presentation)
        );
      })
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.elicitationDetach, () =>
      respond(() => {
        const detach = detachElicitation;
        detachElicitation = undefined;
        detach?.();
      })
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.elicitationSettle, (input: unknown) =>
      respond(() => {
        runtime.elicitationPresenter.settle(parseMcpElicitationSettlement(input));
      })
    ),
  ];
  return {
    close: () => {
      for (const dispose of invocations.values()) {
        dispose();
      }
      invocations.clear();
      detachElicitation?.();
      detachElicitation = undefined;
      unobserveFinalized();
      unsubscribeTasks();
      unwatch();
      for (const handler of handlers) {
        handler.dispose();
      }
    },
  };
}
