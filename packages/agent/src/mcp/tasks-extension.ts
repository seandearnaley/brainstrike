import {
  CancelTaskParamsSchema,
  CancelTaskResultSchema,
  type CreateTaskResult,
  CreateTaskResultSchema,
  GetTaskParamsSchema,
  type GetTaskResult,
  GetTaskResultSchema,
  MCP_TASKS_EXTENSION_ID,
  MCP_TASKS_EXTENSION_SETTINGS,
  MCP_TASKS_EXTENSION_VERSION,
  type McpTasksExtensionSettings,
  parseMcpTaskSubscriptionAcknowledgedNotifications,
  parseMcpTaskSubscriptionNotifications,
  parseMcpTasksExtensionSettings,
  type TaskStatusNotificationParams,
  TaskStatusNotificationParamsSchema,
  UpdateTaskParamsSchema,
  type UpdateTaskResult,
  UpdateTaskResultSchema,
} from '@brainstrike/mcp-tasks-extension';
import type {
  CallToolResult,
  Client,
  JSONObject,
  McpSubscription,
  RequestOptions,
  SubscriptionFilter,
} from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';
import type {
  McpClientExtensionContract,
  McpClientExtensionNotificationContract,
  McpClientExtensionRegistry,
  McpClientExtensionRequestContract,
} from './client-extension-registry';
import { REGISTERED_EXTENSION_RESULT_KEY } from './client-extension-registry';

const TASKS_WIRE_IMPLEMENTATION = Object.freeze({ exactWireContracts: true as const });
const NEGOTIATION_PROBE_TASK_ID = 'brainstrike-tasks-negotiation-probe';
const activeTaskSubscriptions = new WeakSet<Client>();
const MCP_TASKS_CALL_TOOL_PARAMS_SCHEMA = z
  .strictObject({
    arguments: z.record(z.string(), z.json()).optional(),
    name: z.string().min(1),
  })
  .transform(({ arguments: args, name }): JSONObject => {
    const params: JSONObject = { name };
    if (args !== undefined) {
      params['arguments'] = args;
    }
    return params;
  });
const MCP_TASKS_TOOL_RESULT_SCHEMA = z.union([
  z
    .object({ [REGISTERED_EXTENSION_RESULT_KEY]: CreateTaskResultSchema })
    .transform((value) => value[REGISTERED_EXTENSION_RESULT_KEY]),
  CallToolResultSchema,
]);
const registeredResult = <Output>(schema: z.ZodType<Output>) =>
  z
    .object({ [REGISTERED_EXTENSION_RESULT_KEY]: schema })
    .transform((value): Output => value[REGISTERED_EXTENSION_RESULT_KEY]);

export const MCP_TASKS_GET_REQUEST_CONTRACT: McpClientExtensionRequestContract<
  JSONObject,
  GetTaskResult
> = Object.freeze({
  extensionResultType: 'complete',
  mcpNameParam: 'taskId',
  method: 'tasks/get',
  paramsSchema: GetTaskParamsSchema,
  protocol: '2026-07-28',
  resultSchema: registeredResult(GetTaskResultSchema),
});

export const MCP_TASKS_UPDATE_REQUEST_CONTRACT: McpClientExtensionRequestContract<
  JSONObject,
  UpdateTaskResult
> = Object.freeze({
  extensionResultType: 'complete',
  mcpNameParam: 'taskId',
  method: 'tasks/update',
  paramsSchema: UpdateTaskParamsSchema,
  protocol: '2026-07-28',
  resultSchema: registeredResult(UpdateTaskResultSchema),
});

export const MCP_TASKS_CANCEL_REQUEST_CONTRACT: McpClientExtensionRequestContract<
  JSONObject,
  UpdateTaskResult
> = Object.freeze({
  extensionResultType: 'complete',
  mcpNameParam: 'taskId',
  method: 'tasks/cancel',
  paramsSchema: CancelTaskParamsSchema,
  protocol: '2026-07-28',
  resultSchema: registeredResult(CancelTaskResultSchema),
});

export type McpTasksToolResult = CallToolResult | CreateTaskResult;

export const MCP_TASKS_STATUS_NOTIFICATION_CONTRACT: McpClientExtensionNotificationContract<TaskStatusNotificationParams> =
  Object.freeze({
    method: 'notifications/tasks',
    paramsSchema: TaskStatusNotificationParamsSchema,
    protocol: '2026-07-28',
  });

export const MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT: McpClientExtensionRequestContract<
  JSONObject,
  McpTasksToolResult
> = Object.freeze({
  extensionResultType: 'task',
  mcpNameParam: 'name',
  method: 'tools/call',
  paramsSchema: MCP_TASKS_CALL_TOOL_PARAMS_SCHEMA,
  protocol: '2026-07-28',
  resultSchema: MCP_TASKS_TOOL_RESULT_SCHEMA,
});

const MCP_TASKS_WIRE_CONTRACT: McpClientExtensionContract<
  typeof MCP_TASKS_EXTENSION_VERSION,
  McpTasksExtensionSettings,
  typeof TASKS_WIRE_IMPLEMENTATION
> = Object.freeze({
  id: MCP_TASKS_EXTENSION_ID,
  isCompleteImplementation: (value: unknown): value is typeof TASKS_WIRE_IMPLEMENTATION =>
    value === TASKS_WIRE_IMPLEMENTATION,
  isServerSettingsCompatible: () => true,
  notifications: Object.freeze([MCP_TASKS_STATUS_NOTIFICATION_CONTRACT]),
  parseServerSettings: parseMcpTasksExtensionSettings,
  parseSettings: parseMcpTasksExtensionSettings,
  requests: Object.freeze([
    MCP_TASKS_GET_REQUEST_CONTRACT,
    MCP_TASKS_UPDATE_REQUEST_CONTRACT,
    MCP_TASKS_CANCEL_REQUEST_CONTRACT,
    MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT,
  ]),
  version: MCP_TASKS_EXTENSION_VERSION,
});

export interface McpTasksNotificationLease extends Pick<McpSubscription, 'close' | 'closed'> {
  readonly honoredTaskIds: readonly string[];
}

export type McpTasksNotificationHandler = (
  task: TaskStatusNotificationParams
) => Promise<void> | void;

export function registerMcpTasksWireContracts(registry: McpClientExtensionRegistry): void {
  registry.register(MCP_TASKS_WIRE_CONTRACT, {
    implementation: TASKS_WIRE_IMPLEMENTATION,
    settings: MCP_TASKS_EXTENSION_SETTINGS,
    version: MCP_TASKS_EXTENSION_VERSION,
  });
}

export function requireMcpTasksRegistry(
  registry: McpClientExtensionRegistry | undefined,
  operation: string
): McpClientExtensionRegistry {
  if (registry === undefined) {
    throw new Error(`MCP Tasks ${operation} require an extension registry`);
  }
  return registry;
}

async function assertMcpTasksNegotiated(
  client: Client,
  registry: McpClientExtensionRegistry
): Promise<void> {
  await registry.prepareRequest(
    MCP_TASKS_GET_REQUEST_CONTRACT,
    { taskId: NEGOTIATION_PROBE_TASK_ID },
    client.getServerCapabilities()?.extensions,
    client.getNegotiatedProtocolVersion()
  );
}

export async function listenForMcpTasks(
  client: Client,
  registry: McpClientExtensionRegistry,
  taskIds: readonly string[],
  handler: McpTasksNotificationHandler,
  options?: RequestOptions
): Promise<McpTasksNotificationLease> {
  await assertMcpTasksNegotiated(client, registry);
  if (activeTaskSubscriptions.has(client)) {
    throw new Error('MCP Tasks notification lease is already active for this connection');
  }
  const notifications = parseMcpTaskSubscriptionNotifications({ taskIds: [...taskIds] });
  const notificationContract = registry.prepareNotification(
    MCP_TASKS_STATUS_NOTIFICATION_CONTRACT,
    client.getServerCapabilities()?.extensions,
    client.getNegotiatedProtocolVersion()
  );
  activeTaskSubscriptions.add(client);
  try {
    client.setNotificationHandler(
      notificationContract.method,
      { params: notificationContract.paramsSchema },
      handler
    );
  } catch (error) {
    activeTaskSubscriptions.delete(client);
    throw error;
  }
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      client.removeNotificationHandler(notificationContract.method);
      activeTaskSubscriptions.delete(client);
    }
  };
  let subscription: McpSubscription;
  try {
    subscription = await client.listen(notifications as SubscriptionFilter, options);
  } catch (error) {
    release();
    throw error;
  }
  let honoredTaskIds: readonly string[];
  try {
    const acknowledged = parseMcpTaskSubscriptionAcknowledgedNotifications(
      subscription.honoredFilter
    );
    honoredTaskIds = Object.freeze([...(acknowledged.taskIds ?? [])]);
    const requestedTaskIds = new Set(taskIds);
    if (
      new Set(honoredTaskIds).size !== honoredTaskIds.length ||
      honoredTaskIds.some((taskId) => !requestedTaskIds.has(taskId))
    ) {
      throw new Error('MCP Tasks notification acknowledgement is outside the requested task ids.');
    }
  } catch (error) {
    release();
    try {
      await subscription.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'MCP Tasks notification acknowledgement and cleanup failed.'
      );
    }
    throw error;
  }
  const closed = subscription.closed.then(
    (cause) => {
      release();
      return cause;
    },
    (error: unknown) => {
      release();
      throw error;
    }
  );
  return {
    close: async () => {
      release();
      await subscription.close();
    },
    closed,
    honoredTaskIds,
  };
}
