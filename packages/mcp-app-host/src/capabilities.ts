import { expectExactKeys, expectRecord } from './validation.js';

export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui' as const;
export const MCP_APPS_SPEC_VERSION = '2026-01-26' as const;
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app' as const;

export const MCP_APPS_CONTRACT_SOURCE = Object.freeze({
  gitCommit: '92f46a574568a3ddac7600343b7d3c4c4ed7b588',
  package: '@modelcontextprotocol/ext-apps',
  packageVersion: '1.7.5',
  schemaSha256: '002db9178110e644499e781415ee1025e5fde1e54500d14986626ba4a7b5b331',
  specificationUrl:
    'https://github.com/modelcontextprotocol/ext-apps/blob/92f46a574568a3ddac7600343b7d3c4c4ed7b588/specification/2026-01-26/apps.mdx',
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
