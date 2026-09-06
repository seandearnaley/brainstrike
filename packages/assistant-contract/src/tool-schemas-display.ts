/**
 * Tool Schema Display Metadata
 *
 * Browser-safe parameter definitions for native tools, DERIVED from each
 * definition's registered Zod input schema (BST-1646 step c). This registry
 * is for UI and documentation only; it is NEVER an execution or
 * provider-schema source.
 */

import { isNativeToolId, type NativeToolId } from './native-tool-catalog.js';
import { type ToolSchemaDisplay, toToolSchemaDisplay } from './native-tools/display.js';
import { NATIVE_TOOLS } from './native-tools/index.js';

export type {
  ParameterType,
  ToolParameterDisplay,
  ToolSchemaDisplay,
} from './native-tools/display.js';

/**
 * Native tool schema display information, one entry per catalog definition.
 *
 * Entries are DERIVED LAZILY and memoized: importing this registry performs no
 * JSON Schema conversion (the provider wrapper defers its own conversion until
 * first parse for the same reason — `native-tool-input-schema-catalog.spec.ts`
 * pins that nothing in the catalog import path converts at load), and the
 * first read of a tool's entry derives it once. A definition whose schema
 * cannot be displayed, or whose `display` prose names a parameter that does
 * not exist, throws on that first read.
 */
export const NATIVE_TOOL_SCHEMAS: Readonly<Record<NativeToolId, ToolSchemaDisplay>> = Object.freeze(
  Object.defineProperties(
    {} as Record<NativeToolId, ToolSchemaDisplay>,
    Object.fromEntries(
      NATIVE_TOOLS.map((tool): [NativeToolId, PropertyDescriptor] => {
        let derived: ToolSchemaDisplay | undefined;
        return [
          tool.id,
          {
            enumerable: true,
            get: () => {
              derived ??= toToolSchemaDisplay(tool);
              return derived;
            },
          },
        ];
      })
    )
  )
);

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
