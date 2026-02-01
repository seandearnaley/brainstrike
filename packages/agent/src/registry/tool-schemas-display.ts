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
  'brainstrike.hybridSearch': {
    toolId: 'brainstrike.hybridSearch',
    description: 'Search across documents using hybrid semantic and keyword search with RRF fusion',
    parameters: [
      {
        name: 'query',
        type: 'string',
        description: 'Search query text',
        required: true,
        minLength: 1,
        maxLength: 2000,
      },
      {
        name: 'embeddingSetId',
        type: 'string',
        description: 'Embedding set ID for vector search',
        required: true,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Maximum results to return',
        required: false,
        default: 10,
        min: 1,
        max: 100,
      },
      {
        name: 'vectorWeight',
        type: 'number',
        description: 'Weight for vector search (default 1.0)',
        required: false,
        default: 1.0,
        min: 0,
        max: 2,
      },
      {
        name: 'ftsWeight',
        type: 'number',
        description: 'Weight for full-text search (default 1.0)',
        required: false,
        default: 1.0,
        min: 0,
        max: 2,
      },
      {
        name: 'vectorThreshold',
        type: 'number',
        description: 'Minimum similarity threshold',
        required: false,
        min: 0,
        max: 1,
      },
      {
        name: 'filePaths',
        type: 'array',
        description: 'Filter to specific file paths',
        required: false,
        arrayItemType: 'string',
      },
      {
        name: 'chunkType',
        type: 'enum',
        description: 'Filter by chunk type',
        required: false,
        enumValues: ['text', 'code', 'sentence', 'recursive'],
      },
    ],
    returns: 'Array of search results with scores, file paths, and content snippets',
  },

  'brainstrike.retrieveContext': {
    toolId: 'brainstrike.retrieveContext',
    description: 'Retrieve relevant context from indexed documents with token budgeting',
    parameters: [
      {
        name: 'query',
        type: 'string',
        description: 'Search query for context retrieval',
        required: true,
        minLength: 1,
        maxLength: 2000,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Maximum number of results',
        required: false,
        default: 10,
        max: 100,
      },
      {
        name: 'threshold',
        type: 'number',
        description: 'Minimum similarity threshold (0-1)',
        required: false,
        min: 0,
        max: 1,
      },
      {
        name: 'tokenBudget',
        type: 'number',
        description: 'Maximum tokens for returned context',
        required: false,
        max: 200_000,
      },
      {
        name: 'maxChunks',
        type: 'number',
        description: 'Maximum chunks to return',
        required: false,
        max: 100,
      },
      {
        name: 'embeddingSetId',
        type: 'string',
        description: 'Specific embedding set to search',
        required: false,
      },
      {
        name: 'filePaths',
        type: 'array',
        description: 'Filter to specific file paths',
        required: false,
        arrayItemType: 'string',
      },
      {
        name: 'selectionSnapshotId',
        type: 'string',
        description: 'Selection snapshot for scoped retrieval',
        required: false,
      },
    ],
    returns: 'Formatted context string with source citations',
  },

  'brainstrike.queueStatus': {
    toolId: 'brainstrike.queueStatus',
    description: 'Check embedding queue health, coverage, and latency',
    parameters: [
      {
        name: 'embeddingSetId',
        type: 'string',
        description: 'Filter to specific embedding set',
        required: false,
      },
    ],
    returns: 'Queue statistics including pending jobs, coverage percentage, and processing latency',
  },

  'brainstrike.packContext': {
    toolId: 'brainstrike.packContext',
    description: 'Pack retrieved chunks into token-budgeted context',
    parameters: [
      {
        name: 'chunks',
        type: 'array',
        description: 'Chunks to pack',
        required: true,
        arrayItemType: 'object',
      },
      {
        name: 'tokenBudget',
        type: 'number',
        description: 'Maximum tokens for output',
        required: true,
      },
    ],
    returns: 'Formatted context string within token budget',
  },

  'brainstrike.listEmbeddingSets': {
    toolId: 'brainstrike.listEmbeddingSets',
    description: 'List available embedding collections',
    parameters: [
      {
        name: 'includeStats',
        type: 'boolean',
        description: 'Include coverage statistics',
        required: false,
        default: false,
      },
    ],
    returns: 'Array of embedding sets with IDs, names, models, and optional stats',
  },

  'brainstrike.createEmbeddingSet': {
    toolId: 'brainstrike.createEmbeddingSet',
    description: 'Create a new embedding collection',
    parameters: [
      {
        name: 'name',
        type: 'string',
        description: 'Name for the embedding set',
        required: true,
        minLength: 1,
        maxLength: 100,
      },
      {
        name: 'modelKey',
        type: 'string',
        description: 'Model key (provider::model format)',
        required: true,
      },
      {
        name: 'description',
        type: 'string',
        description: 'Optional description',
        required: false,
        maxLength: 500,
      },
    ],
    returns: 'Created embedding set with ID and configuration',
  },

  'brainstrike.createSelectionScope': {
    toolId: 'brainstrike.createSelectionScope',
    description: 'Create a scoped retrieval context from selected files',
    parameters: [
      {
        name: 'filePaths',
        type: 'array',
        description: 'File paths to include in scope',
        required: true,
        arrayItemType: 'string',
      },
      {
        name: 'name',
        type: 'string',
        description: 'Name for the selection scope',
        required: false,
      },
    ],
    returns: 'Selection snapshot ID for scoped retrieval',
  },

  'brainstrike.queryFileTree': {
    toolId: 'brainstrike.queryFileTree',
    description: 'Query directories and search files in imported folders',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Directory path to query (defaults to root)',
        required: false,
      },
      {
        name: 'pattern',
        type: 'string',
        description: 'Glob pattern to filter files',
        required: false,
      },
      {
        name: 'maxDepth',
        type: 'number',
        description: 'Maximum depth to traverse',
        required: false,
        min: 1,
        max: 10,
      },
      {
        name: 'includeHidden',
        type: 'boolean',
        description: 'Include hidden files/directories',
        required: false,
        default: false,
      },
    ],
    returns: 'File tree structure with paths, types, and sizes',
  },

  'brainstrike.importFiles': {
    toolId: 'brainstrike.importFiles',
    description: 'Batch import and index documents',
    parameters: [
      {
        name: 'filePaths',
        type: 'array',
        description: 'File paths to import',
        required: true,
        arrayItemType: 'string',
      },
      {
        name: 'embeddingSetId',
        type: 'string',
        description: 'Target embedding set for indexing',
        required: true,
      },
      {
        name: 'recursive',
        type: 'boolean',
        description: 'Import directories recursively',
        required: false,
        default: false,
      },
    ],
    returns: 'Import results with success/failure counts',
  },

  'brainstrike.systemDiagnostics': {
    toolId: 'brainstrike.systemDiagnostics',
    description: 'Check database, queue, and worker health',
    parameters: [
      {
        name: 'categories',
        type: 'array',
        description: 'Diagnostic categories to check',
        required: false,
        arrayItemType: 'enum',
        enumValues: ['database', 'queue', 'worker', 'storage', 'all'],
      },
    ],
    returns: 'Diagnostic report with status, metrics, and any errors',
  },

  'brainstrike.reembedCollection': {
    toolId: 'brainstrike.reembedCollection',
    description: 'Trigger re-embedding for a collection',
    parameters: [
      {
        name: 'embeddingSetId',
        type: 'string',
        description: 'Embedding set ID to re-embed',
        required: true,
      },
      {
        name: 'reason',
        type: 'string',
        description: 'Reason for re-embedding',
        required: false,
        maxLength: 200,
      },
    ],
    returns: 'Job ID and estimated completion time',
  },

  'web.searchDocs': {
    toolId: 'web.searchDocs',
    description: 'Search documentation',
    parameters: [
      {
        name: 'query',
        type: 'string',
        description: 'Search query',
        required: true,
        minLength: 2,
        maxLength: 200,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Maximum results',
        required: false,
        default: 5,
        max: 10,
      },
    ],
    returns: 'Array of matching documentation entries',
  },

  'web.docSummary': {
    toolId: 'web.docSummary',
    description: 'Get summary of a documentation page',
    parameters: [
      {
        name: 'docId',
        type: 'string',
        description: 'Document ID',
        required: true,
        maxLength: 120,
      },
    ],
    returns: 'Summary text and metadata',
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
