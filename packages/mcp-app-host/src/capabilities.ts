import { expectExactKeys, expectRecord } from './validation.js';

export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui' as const;
export const MCP_APPS_SPEC_VERSION = '2026-01-26' as const;
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app' as const;

export const MCP_APPS_CONTRACT_SOURCE = Object.freeze({
  gitCommit: '82221c0c8ce7661efa6771c9d461511b1650495f',
  package: '@modelcontextprotocol/ext-apps',
  packageVersion: '2.0.3',
  schemaSha256: 'e9af2289956641a266d99273facb746c2023bae48567d64bb83c63aadecb856f',
  specificationUrl:
    'https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/specification/2026-01-26/apps.mdx',
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
