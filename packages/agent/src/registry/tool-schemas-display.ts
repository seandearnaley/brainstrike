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
  arrayItemType?: ParameterType;
  default?: unknown;
  description: string;
  enumValues?: string[];
  max?: number;
  maxLength?: number;
  min?: number;
  minLength?: number;
  name: string;
  required: boolean;
  type: ParameterType;
}

/**
 * Complete schema display info for a tool.
 */
export interface ToolSchemaDisplay {
  description: string;
  parameters: ToolParameterDisplay[];
  returns: string;
  toolId: string;
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

  'brainstrike.listWorkspaceContext': {
    toolId: 'brainstrike.listWorkspaceContext',
    description:
      'Inspect the selected workspace context and workspace index hint without returning file contents. Use this before reading selected files.',
    parameters: [
      {
        name: 'includeTokenEstimates',
        type: 'boolean',
        description: 'Include selected-file token estimates when they are already available',
        required: false,
        default: false,
      },
    ],
    returns:
      'Workspace root, selected paths, selected count, workspace index hint, and optional metadata',
  },

  'brainstrike.readWorkspaceContext': {
    toolId: 'brainstrike.readWorkspaceContext',
    description:
      'Read selected or explicit workspace files under bounded file, per-file, and token limits. Use after semantic retrieval when exact source is needed.',
    parameters: [
      {
        name: 'filePaths',
        type: 'array',
        description: 'Workspace-relative file paths to read. Defaults to selected context files.',
        required: false,
        arrayItemType: 'string',
      },
      {
        name: 'tokenBudget',
        type: 'number',
        description: 'Maximum approximate output tokens for all returned file contents',
        required: false,
        default: 4000,
        min: 1,
        max: 200_000,
      },
      {
        name: 'maxFiles',
        type: 'number',
        description: 'Maximum files to include',
        required: false,
        default: 20,
        min: 1,
        max: 500,
      },
      {
        name: 'maxCharsPerFile',
        type: 'number',
        description: 'Maximum characters to return per file before truncation',
        required: false,
        default: 12_000,
        min: 1,
        max: 50_000,
      },
      {
        name: 'useTapestrySelections',
        type: 'boolean',
        description:
          'Apply selected Tapestry line ranges from the curated workspace context when available',
        required: false,
        default: true,
      },
    ],
    returns:
      'Included file contents plus explicit skipped-file, truncation, and approximate token metadata',
  },

  'brainstrike.updateWorkspaceContextSelection': {
    toolId: 'brainstrike.updateWorkspaceContextSelection',
    description:
      'Bulk update files selected in the workspace context explorer. Use this when curating reusable context for a prompt.',
    parameters: [
      {
        name: 'filePaths',
        type: 'array',
        description: 'Workspace-relative file paths to select',
        required: true,
        arrayItemType: 'string',
        minLength: 1,
      },
      {
        name: 'mode',
        type: 'enum',
        description: 'Selection update strategy',
        required: false,
        default: 'add',
        enumValues: ['replace', 'add', 'remove'],
      },
      {
        name: 'folderId',
        type: 'string',
        description: 'Optional folder id for multi-root workspaces',
        required: false,
      },
    ],
    returns: 'Selection update result with applied and skipped paths',
  },

  'brainstrike.updateWorkspaceTapestrySelections': {
    toolId: 'brainstrike.updateWorkspaceTapestrySelections',
    description:
      'Create, update, or clear Tapestry line ranges for curated workspace context files. Ranges are 1-based and inclusive.',
    parameters: [
      {
        name: 'updates',
        type: 'array',
        description:
          'Per-file range updates: each item has path and ranges with startLine/endLine/isActive',
        required: true,
        arrayItemType: 'object',
        minLength: 1,
      },
      {
        name: 'mode',
        type: 'enum',
        description: 'Range update strategy per file',
        required: false,
        default: 'replace',
        enumValues: ['replace', 'add', 'clear'],
      },
      {
        name: 'folderId',
        type: 'string',
        description: 'Optional folder id for multi-root workspaces',
        required: false,
      },
      {
        name: 'selectFiles',
        type: 'boolean',
        description: 'Also add affected files to the workspace context selection',
        required: false,
        default: true,
      },
    ],
    returns: 'Tapestry update result with applied and skipped file metadata',
  },

  'brainstrike.listEmbeddingSpaces': {
    toolId: 'brainstrike.listEmbeddingSpaces',
    description:
      'List available embedding spaces and identify the configured workspace index. Use this before semantic retrieval because queryEmbeddingSpace requires an explicit embeddingSetId.',
    parameters: [
      {
        name: 'includeStats',
        type: 'boolean',
        description: 'Include optional chunk coverage statistics',
        required: false,
        default: false,
      },
      {
        name: 'workspaceIndexOnly',
        type: 'boolean',
        description: 'Only return the embedding space configured as the current workspace index',
        required: false,
        default: false,
      },
    ],
    returns:
      'Embedding spaces with model, dimensions, distance, workspace-index recommendation flags, and optional coverage stats',
  },

  'brainstrike.queryEmbeddingSpace': {
    toolId: 'brainstrike.queryEmbeddingSpace',
    description:
      'Query a specific embedding space by explicit embeddingSetId and return packed source text plus metadata-only semantic chunks with persisted line ranges. For codebase searches, prefer the workspace index returned by listEmbeddingSpaces.',
    parameters: [
      {
        name: 'embeddingSetId',
        type: 'string',
        description:
          'Embedding space ID returned by listEmbeddingSpaces; prefer the recommended workspace index for codebase searches',
        required: true,
        minLength: 1,
      },
      {
        name: 'query',
        type: 'string',
        description: 'Semantic retrieval query text',
        required: true,
        minLength: 1,
        maxLength: 2000,
      },
      {
        name: 'tokenBudget',
        type: 'number',
        description: 'Maximum approximate tokens to pack into the retrieval result',
        required: false,
        default: 4000,
        min: 1,
        max: 200_000,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Maximum candidate chunks to retrieve',
        required: false,
        default: 20,
        min: 1,
        max: 100,
      },
      {
        name: 'threshold',
        type: 'number',
        description: 'Minimum similarity threshold',
        required: false,
        default: 0.3,
        min: 0,
        max: 1,
      },
      {
        name: 'filePaths',
        type: 'array',
        description: 'Optional workspace-relative file paths to constrain retrieval',
        required: false,
        arrayItemType: 'string',
      },
    ],
    returns:
      'Packed semantic chunks with source line ranges, offsets, chunk metadata, budget, and skipped counts',
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
