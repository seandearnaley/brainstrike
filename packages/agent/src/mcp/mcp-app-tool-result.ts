import {
  createMcpAppToolInvocationResult,
  MCP_APPS_MIME_TYPE,
  type McpAppToolInvocationResult,
  readMcpAppToolInvocationResult,
} from '@brainstrike/assistant-contract';
import { type McpAppResourceUri, parseMcpAppToolMeta } from '@brainstrike/mcp-app-host/metadata';
import { projectMcpTaskToolModelOutput } from './mcp-task-tool-result';

export interface McpAppToolResultOrigin {
  readonly resourceUri: McpAppResourceUri;
  readonly serverId: string;
  readonly toolName: string;
}

/** Whether a definition advertises the metadata namespace this slice validates. */
export function hasMcpAppToolMeta(meta: Record<string, unknown> | undefined): boolean {
  return Boolean(meta && Object.hasOwn(meta, 'ui'));
}

/**
 * Strictly parse a discovered tool definition's `_meta.ui`. Definitions with
 * no `ui` member are ordinary MCP tools; a present malformed member throws.
 */
export function readMcpAppToolResourceUri(
  meta: Record<string, unknown> | undefined
): McpAppResourceUri | undefined {
  if (!hasMcpAppToolMeta(meta)) {
    return;
  }
  return parseMcpAppToolMeta(meta?.['ui']).resourceUri;
}

/** Preserve the ordinary domain result under the renderer-owned Apps marker. */
export function createMcpAppToolResult(
  origin: McpAppToolResultOrigin | undefined,
  ordinaryResult: unknown
): McpAppToolInvocationResult | unknown {
  if (!origin) {
    return ordinaryResult;
  }
  return createMcpAppToolInvocationResult(
    {
      mimeType: MCP_APPS_MIME_TYPE,
      resourceUri: origin.resourceUri,
      serverId: origin.serverId,
      toolName: origin.toolName,
    },
    ordinaryResult
  );
}

/**
 * Compose the Apps raw/model split with the Tasks projector. The central
 * model-output seam passes an Apps marker's inner result to this projector and
 * applies its ordinary generic projection when this returns `undefined`.
 */
export function projectMcpAppOrTaskToolModelOutput(output: unknown): unknown {
  const appResult = readMcpAppToolInvocationResult(output);
  return projectMcpTaskToolModelOutput(appResult?.result ?? output);
}
