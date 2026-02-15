/**
 * Tool Schema Display Metadata
 *
 * Browser-safe parameter definitions for native tools.
 * These are simplified representations of the Zod schemas for UI display.
 */

/**
 * Parameter type for display purposes.
 */
export type ParameterType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum';

/**
 * Single parameter definition for UI display.
 */
export interface ToolParameterDisplay {
  name: string;
  type: ParameterType;
  description: string;
  required: boolean;
  default?: unknown;
  enumValues?: string[];
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  arrayItemType?: ParameterType;
}

/**
 * Complete schema display info for a tool.
 */
export interface ToolSchemaDisplay {
  toolId: string;
  description: string;
  parameters: ToolParameterDisplay[];
  returns: string;
}

/**
 * Native tool schema display information.
 * This is a browser-safe representation of the Zod schemas.
 */
export const NATIVE_TOOL_SCHEMAS: Record<string, ToolSchemaDisplay> = {
  'brainstrike.readWorkspaceFile': {
    toolId: 'brainstrike.readWorkspaceFile',
    description:
      'Read a workspace file from the selected root. Supports line ranges and output truncation for token efficiency.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Workspace-relative file path to read',
        required: true,
        minLength: 1,
      },
      {
        name: 'startLine',
        type: 'number',
        description: '1-based starting line (inclusive)',
        required: false,
        min: 1,
      },
      {
        name: 'endLine',
        type: 'number',
        description: '1-based ending line (inclusive)',
        required: false,
        min: 1,
      },
      {
        name: 'maxChars',
        type: 'number',
        description: 'Maximum characters to return before truncating',
        required: false,
        default: 12_000,
        min: 200,
        max: 50_000,
      },
    ],
    returns:
      'File content payload with metadata, including truncation status and approximate token count',
  },

  'brainstrike.readWorkspaceDirectory': {
    toolId: 'brainstrike.readWorkspaceDirectory',
    description:
      'List workspace directory entries in a compact format with bounded depth and entry limits.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Directory path to list (defaults to workspace root)',
        required: false,
      },
      {
        name: 'depth',
        type: 'number',
        description: 'Maximum directory depth to traverse',
        required: false,
        default: 1,
        min: 0,
        max: 5,
      },
      {
        name: 'maxEntries',
        type: 'number',
        description: 'Maximum entries to return',
        required: false,
        default: 150,
        min: 1,
        max: 500,
      },
      {
        name: 'includeFiles',
        type: 'boolean',
        description: 'Include file entries',
        required: false,
        default: true,
      },
      {
        name: 'includeDirectories',
        type: 'boolean',
        description: 'Include directory entries',
        required: false,
        default: true,
      },
      {
        name: 'includeHidden',
        type: 'boolean',
        description: 'Include hidden files and directories',
        required: false,
        default: false,
      },
    ],
    returns: 'Directory summary with compact entries and truncation metadata',
  },

  'brainstrike.selectRootTreeFiles': {
    toolId: 'brainstrike.selectRootTreeFiles',
    description:
      'Batch select files from the left root tree so they populate the preview/context panel candidate set.',
    parameters: [
      {
        name: 'filePaths',
        type: 'array',
        description: 'Workspace-relative file paths to update in root-tree selection',
        required: true,
        arrayItemType: 'string',
      },
      {
        name: 'mode',
        type: 'enum',
        description: 'How to apply the root-tree batch update',
        required: false,
        enumValues: ['replace', 'add', 'remove'],
        default: 'add',
      },
      {
        name: 'folderId',
        type: 'string',
        description: 'Optional folder identifier when multiple roots are present',
        required: false,
      },
    ],
    returns: 'Root-tree selection update summary with applied path counts',
  },

  'brainstrike.updatePreviewContextFiles': {
    toolId: 'brainstrike.updatePreviewContextFiles',
    description:
      'Batch add, remove, or replace files in the preview context selection used by the agent.',
    parameters: [
      {
        name: 'filePaths',
        type: 'array',
        description: 'Workspace-relative file paths to update in preview context selection',
        required: true,
        arrayItemType: 'string',
      },
      {
        name: 'mode',
        type: 'enum',
        description: 'How to apply the preview-context batch update',
        required: false,
        enumValues: ['replace', 'add', 'remove'],
        default: 'add',
      },
      {
        name: 'folderId',
        type: 'string',
        description: 'Optional folder identifier when multiple roots are present',
        required: false,
      },
    ],
    returns: 'Preview-context selection update summary with applied path counts',
  },
};

/**
 * Get schema display info for a tool.
 */
export function getToolSchemaDisplay(toolId: string): ToolSchemaDisplay | undefined {
  return NATIVE_TOOL_SCHEMAS[toolId];
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
