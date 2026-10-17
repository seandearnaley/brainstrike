import { omitUndefinedOptional } from '@brainstrike/assistant-contract/schema-boundary';
import { sdkSchema } from '@brainstrike/assistant-contract/sdk-schema';
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
import { Schema, SchemaGetter } from 'effect';
import type {
  McpClientExtensionContract,
  McpClientExtensionNotificationContract,
  McpClientExtensionRegistry,
  McpClientExtensionRequestContract,
} from './client-extension-registry';
import { REGISTERED_EXTENSION_RESULT_KEY } from './client-extension-registry';
import type {
  McpSubscriptionAcknowledgementCapture,
  RegisteredExtensionDispatchLedger,
} from './registered-extension-dispatch';

const TASKS_WIRE_IMPLEMENTATION = Object.freeze({ exactWireContracts: true as const });
const NEGOTIATION_PROBE_TASK_ID = 'brainstrike-tasks-negotiation-probe';
const activeTaskSubscriptions = new WeakSet<Client>();
const MCP_TASKS_CALL_TOOL_PARAMS_SCHEMA = Schema.toStandardSchemaV1(
  Schema.Struct({
    arguments: omitUndefinedOptional(Schema.Record(Schema.String, Schema.MutableJson)),
    name: Schema.String.check(Schema.isMinCodePoints(1)),
  }),
  { parseOptions: { onExcessProperty: 'error' } }
);
const MCP_TASKS_TOOL_RESULT_SCHEMA = Schema.toStandardSchemaV1(
  Schema.Union([
    Schema.Struct({ [REGISTERED_EXTENSION_RESULT_KEY]: CreateTaskResultSchema }).pipe(
      Schema.decodeTo(Schema.toType(CreateTaskResultSchema), {
        decode: SchemaGetter.transform((value) => value[REGISTERED_EXTENSION_RESULT_KEY]),
        encode: SchemaGetter.transform((value) => ({ [REGISTERED_EXTENSION_RESULT_KEY]: value })),
      })
    ),
    sdkSchema(CallToolResultSchema),
  ])
);
const restoreCompleteResult = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardSchemaV1(
    Schema.Unknown.pipe(
      Schema.decodeTo(schema, {
        decode: SchemaGetter.transform((value) =>
          typeof value === 'object' && value !== null && !Array.isArray(value)
            ? { resultType: 'complete', ...value }
            : value
        ),
        encode: SchemaGetter.passthrough(),
      })
    )
  );

export const MCP_TASKS_GET_REQUEST_CONTRACT: McpClientExtensionRequestContract<
  JSONObject,
  GetTaskResult
> = Object.freeze({
  mcpNameParam: 'taskId',
  method: 'tasks/get',
  paramsSchema: Schema.toStandardSchemaV1(GetTaskParamsSchema),
  protocol: '2026-07-28',
  resultSchema: restoreCompleteResult(GetTaskResultSchema),
});

export const MCP_TASKS_UPDATE_REQUEST_CONTRACT: McpClientExtensionRequestContract<
  JSONObject,
  UpdateTaskResult
> = Object.freeze({
  mcpNameParam: 'taskId',
  method: 'tasks/update',
  paramsSchema: Schema.toStandardSchemaV1(UpdateTaskParamsSchema),
  protocol: '2026-07-28',
  resultSchema: restoreCompleteResult(UpdateTaskResultSchema),
});

export const MCP_TASKS_CANCEL_REQUEST_CONTRACT: McpClientExtensionRequestContract<
  JSONObject,
  UpdateTaskResult
> = Object.freeze({
  mcpNameParam: 'taskId',
  method: 'tasks/cancel',
  paramsSchema: Schema.toStandardSchemaV1(CancelTaskParamsSchema),
  protocol: '2026-07-28',
  resultSchema: restoreCompleteResult(CancelTaskResultSchema),
});

export type McpTasksToolResult = CallToolResult | CreateTaskResult;

export const MCP_TASKS_STATUS_NOTIFICATION_CONTRACT: McpClientExtensionNotificationContract<TaskStatusNotificationParams> =
  Object.freeze({
    method: 'notifications/tasks',
    paramsSchema: Schema.toStandardSchemaV1(TaskStatusNotificationParamsSchema),
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

/**
 * The honored task ids the server actually acknowledged, read from the raw
 * acknowledgement captured by the transport dispatch bridge. `listen()` resolves
 * on any acknowledgement, and its `honoredFilter` is the CORE
 * `SubscriptionFilter` — `taskIds` is stripped before it reaches us — so an
 * unacknowledged task id is invisible on the SDK surface and a lease would
 * otherwise look active while it can never emit for that task (BST-1596).
 */
function resolveHonoredTaskIds(
  capture: McpSubscriptionAcknowledgementCapture,
  taskIds: readonly string[]
): readonly string[] {
  if (!capture.acknowledged) {
    throw new Error(
      'MCP Tasks notification acknowledgement was never observed on this connection.'
    );
  }
  const acknowledged = parseMcpTaskSubscriptionAcknowledgedNotifications(capture.acknowledgement);
  const honoredTaskIds = Object.freeze([...(acknowledged.taskIds ?? [])]);
  const requestedTaskIds = new Set(taskIds);
  if (
    new Set(honoredTaskIds).size !== honoredTaskIds.length ||
    honoredTaskIds.some((taskId) => !requestedTaskIds.has(taskId))
  ) {
    throw new Error('MCP Tasks notification acknowledgement is outside the requested task ids.');
  }
  const honored = new Set(honoredTaskIds);
  const rejected = taskIds.filter((taskId) => !honored.has(taskId));
  if (rejected.length > 0) {
    throw new Error(
      `MCP Tasks notification acknowledgement rejected task ids: ${rejected.join(', ')}`
    );
  }
  return honoredTaskIds;
}

export async function listenForMcpTasks(
  client: Client,
  registry: McpClientExtensionRegistry,
  dispatchLedger: RegisteredExtensionDispatchLedger,
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
  let capture: McpSubscriptionAcknowledgementCapture;
  try {
    capture = dispatchLedger.captureSubscriptionAcknowledgement(notifications);
  } catch (error) {
    release();
    throw error;
  }
  let subscription: McpSubscription;
  try {
    subscription = await client.listen(notifications as SubscriptionFilter, options);
  } catch (error) {
    capture.release();
    release();
    throw error;
  }
  let honoredTaskIds: readonly string[];
  try {
    honoredTaskIds = resolveHonoredTaskIds(capture, taskIds);
  } catch (error) {
    release();
    // The transport may reject `closed` on exactly this path; keep it handled.
    void subscription.closed.catch(() => undefined);
    try {
      await subscription.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'MCP Tasks notification acknowledgement and cleanup failed.'
      );
    }
    throw error;
  } finally {
    capture.release();
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
