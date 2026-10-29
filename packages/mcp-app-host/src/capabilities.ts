import { expectExactKeys, expectRecord } from './validation.ts';

export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui' as const;
export const MCP_APPS_SPEC_VERSION = '2026-01-26' as const;
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app' as const;

export const MCP_APPS_CONTRACT_SOURCE = Object.freeze({
  gitCommit: '7af9a75da720b8a81be0f9aff47b25f75e9530ad',
  package: '@modelcontextprotocol/ext-apps',
  packageVersion: '2.0.4',
  schemaSha256: '3823abdec2ab00069420812520c20f561428e1bf328c8f61189094f5160e33d9',
  specificationUrl:
    'https://github.com/modelcontextprotocol/ext-apps/blob/7af9a75da720b8a81be0f9aff47b25f75e9530ad/specification/2026-01-26/apps.mdx',
} as const);

export interface McpAppsClientCapability {
  readonly mimeTypes: readonly [typeof MCP_APPS_MIME_TYPE];
}

const MIME_TYPES = Object.freeze([MCP_APPS_MIME_TYPE]) as readonly [typeof MCP_APPS_MIME_TYPE];

export const MCP_APPS_CLIENT_CAPABILITY: McpAppsClientCapability = Object.freeze({
  mimeTypes: MIME_TYPES,
});

export function parseMcpAppsClientCapability(value: unknown): McpAppsClientCapability {
  const label = 'MCP Apps client capability';
  const record = expectRecord(value, label);
  expectExactKeys(record, ['mimeTypes'], ['mimeTypes'], label);

  const mimeTypes = record['mimeTypes'];
  if (!Array.isArray(mimeTypes) || mimeTypes.length !== 1 || mimeTypes[0] !== MCP_APPS_MIME_TYPE) {
    throw new TypeError(`${label}.mimeTypes must be exactly ["${MCP_APPS_MIME_TYPE}"]`);
  }

  return MCP_APPS_CLIENT_CAPABILITY;
}
