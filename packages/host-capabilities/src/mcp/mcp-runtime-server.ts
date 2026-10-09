import { readMcpCreatedTaskResult } from '@brainstrike/agent';
import { parseMcpHostControlRequest, parseMcpHostOperation } from '@brainstrike/assistant-contract';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { MCP_RUNTIME_METHODS, MCP_RUNTIME_NOTIFICATIONS, respond } from './mcp-runtime-wire.js';
import type { McpHostRuntime } from './node-host-runtime.js';
import type { McpSettingsAuthority } from './settings-authority.js';

function tokenSignal(token: CancellationToken): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new DOMException('Cancelled by Main', 'AbortError'));
  const subscription = token.onCancellationRequested(cancel);
  if (token.isCancellationRequested) {
    cancel();
  }
  return { dispose: () => subscription.dispose(), signal: controller.signal };
}

/**
 * Serve the Node host's one MCP runtime to Main's remaining renderer surfaces
 * over the private connection (interim until c5b-e make them public host
 * methods). Main never owns a second runtime, session, task or settings
 * authority: it mirrors the host's tool registry for its own readers.
 */
export function serveMcpRuntimeToMain(
  connection: MessageConnection,
  runtime: McpHostRuntime,
  settings: McpSettingsAuthority
): { close(): void } {
  const invocations = new Map<string, () => void>();
  const notify = (method: string, payload: unknown): void => {
    // Main may already be gone during shutdown; the runtime does not depend on delivery.
    void connection.sendNotification(method, payload).catch(() => undefined);
  };
  const unwatch = runtime.host.watch({}, (event) => notify(MCP_RUNTIME_NOTIFICATIONS.watch, event));
  const unsubscribeSettings = settings.subscribe((event) => {
    if (event.type === 'tools') {
      notify(MCP_RUNTIME_NOTIFICATIONS.tools, event.tools);
    }
  });
  const handlers = [
    connection.onRequest(MCP_RUNTIME_METHODS.snapshot, () =>
      respond(async () => ({
        extensionPreferences: runtime.mcpExtensionPreferences,
        snapshot: runtime.host.snapshot(),
        tools: await settings.tools(),
      }))
    ),
    // A control reloads the settings authority's discovery as Settings expects.
    connection.onRequest(MCP_RUNTIME_METHODS.control, (input: unknown) =>
      respond(() => settings.control(parseMcpHostControlRequest(input)))
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.configPathPick, (input: unknown) =>
      respond(() => settings.pickConfigPath(z.strictObject({ path: z.string() }).parse(input).path))
    ),
    connection.onRequest(MCP_RUNTIME_METHODS.settingsReset, () => respond(() => settings.reset())),
    connection.onRequest(MCP_RUNTIME_METHODS.settingsResume, (input: unknown) =>
      respond(() =>
        settings.resume(
          z.strictObject({ outcome: z.enum(['failed', 'succeeded']) }).parse(input).outcome
        )
      )
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
  ];
  return {
    close: () => {
      for (const dispose of invocations.values()) {
        dispose();
      }
      invocations.clear();
      unsubscribeSettings();
      unwatch();
      for (const handler of handlers) {
        handler.dispose();
      }
    },
  };
}
