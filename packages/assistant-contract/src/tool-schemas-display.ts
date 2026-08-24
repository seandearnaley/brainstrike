/**
 * Tool Schema Display Metadata
 *
 * Browser-safe parameter definitions for native tools.
 * These are simplified representations of the Zod schemas for UI display.
 */

import { isNativeToolId, type NativeToolId } from './native-tool-catalog.js';
import { EXECUTION_TOOL_SCHEMAS } from './tool-schemas-display-execution.js';
import { SEARCH_TOOL_SCHEMAS } from './tool-schemas-display-search.js';
import { TASK_TOOL_SCHEMAS } from './tool-schemas-display-tasks.js';
import type { ToolSchemaDisplay } from './tool-schemas-display-types.js';
import { WORKSPACE_TOOL_SCHEMAS } from './tool-schemas-display-workspace.js';

export type {
  ParameterType,
  ToolParameterDisplay,
  ToolSchemaDisplay,
} from './tool-schemas-display-types.js';

/**
 * Native tool schema display information.
 * This is a browser-safe representation of the Zod schemas.
 */
export const NATIVE_TOOL_SCHEMAS: Record<NativeToolId, ToolSchemaDisplay> = {
  ...WORKSPACE_TOOL_SCHEMAS,
  ...SEARCH_TOOL_SCHEMAS,
  ...EXECUTION_TOOL_SCHEMAS,
  ...TASK_TOOL_SCHEMAS,
};

/**
 * Get schema display info for a tool.
 */
export function getToolSchemaDisplay(toolId: string): ToolSchemaDisplay | undefined {
  return isNativeToolId(toolId) ? NATIVE_TOOL_SCHEMAS[toolId] : undefined;
}

/**
 * Generate example JSON input from schema display.
 */
export function generateExampleInput(schema: ToolSchemaDisplay): Record<string, unknown> {
  const example: Record<string, unknown> = {};

  for (const param of schema.parameters) {
    if (param.required) {
      switch (param.type) {
        case 'string':
          example[param.name] = param.enumValues?.[0] ?? `<${param.name}>`;
          break;
        case 'number':
          example[param.name] = param.default ?? param.min ?? 1;
          break;
        case 'boolean':
          example[param.name] = param.default ?? false;
          break;
        case 'array':
          example[param.name] = [];
          break;
        case 'enum':
          example[param.name] = param.enumValues?.[0] ?? '';
          break;
        case 'object':
          example[param.name] = {};
          break;
      }
    }
  }

  return example;
}
