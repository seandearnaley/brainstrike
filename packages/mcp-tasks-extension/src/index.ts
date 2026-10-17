import { Schema } from 'effect';
import { type TasksExtensionCapability, TasksExtensionCapabilitySchema } from './schema.js';

export * from './parsers.js';
export * from './provenance.js';
export * from './schema.js';

export const MCP_TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks' as const;
export const MCP_TASKS_EXTENSION_VERSION = '2026-07-28' as const;

export const MCP_TASKS_REQUEST_METHODS = Object.freeze([
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
] as const);
export const MCP_TASKS_NOTIFICATION_METHODS = Object.freeze(['notifications/tasks'] as const);
export const MCP_TASKS_METHODS = Object.freeze([
  ...MCP_TASKS_REQUEST_METHODS,
  ...MCP_TASKS_NOTIFICATION_METHODS,
] as const);

export const McpTasksMethodSchema = Schema.Literals(MCP_TASKS_METHODS);

export type McpTasksMethod = (typeof McpTasksMethodSchema)['Type'];

export const McpTasksExtensionSettingsSchema = TasksExtensionCapabilitySchema;

export type McpTasksExtensionSettings = TasksExtensionCapability;

export const MCP_TASKS_EXTENSION_SETTINGS: McpTasksExtensionSettings = Object.freeze({});

export function parseMcpTasksExtensionSettings(value: unknown): McpTasksExtensionSettings {
  return Schema.decodeUnknownSync(McpTasksExtensionSettingsSchema, { onExcessProperty: 'error' })(
    value
  );
}

export function parseMcpTasksMethod(value: unknown): McpTasksMethod {
  return Schema.decodeUnknownSync(McpTasksMethodSchema)(value);
}
