import { McpUiResourceMetaSchema, McpUiToolMetaSchema } from '@modelcontextprotocol/ext-apps';
import { MCP_APPS_MIME_TYPE } from './capabilities.ts';
import {
  expectEncodedSize,
  MCP_APP_MAX_METADATA_BYTES,
  parseCanonicalRecord,
} from './validation.ts';

const MAX_URI_LENGTH = 2048;
const MAX_METADATA_COLLECTION_ENTRIES = 32;

export type McpAppResourceUri = `ui://${string}`;
export type McpAppToolVisibility = 'model' | 'app';

export interface McpAppResourceCsp {
  readonly baseUriDomains?: readonly string[];
  readonly connectDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
}

export interface McpAppResourcePermissions {
  readonly camera?: Readonly<Record<string, never>>;
  readonly clipboardWrite?: Readonly<Record<string, never>>;
  readonly geolocation?: Readonly<Record<string, never>>;
  readonly microphone?: Readonly<Record<string, never>>;
}

export interface McpAppResourceMeta {
  readonly csp?: McpAppResourceCsp;
  readonly domain?: string;
  readonly permissions?: McpAppResourcePermissions;
  readonly prefersBorder?: boolean;
}

export interface McpAppToolMeta {
  readonly resourceUri?: McpAppResourceUri;
  readonly visibility?: readonly McpAppToolVisibility[];
}

function parseResourceUri(value: unknown, label: string): McpAppResourceUri {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  if (!value.startsWith('ui://')) {
    throw new TypeError(`${label} must use the ui:// scheme`);
  }
  if (value.length > MAX_URI_LENGTH) {
    throw new TypeError(`${label} length must not exceed ${MAX_URI_LENGTH} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error: unknown) {
    throw new TypeError(`${label} must be a valid ui:// URI`, { cause: error });
  }
  if (parsed.protocol !== 'ui:' || (parsed.host.length === 0 && parsed.pathname.length === 0)) {
    throw new TypeError(`${label} must identify a non-empty ui:// resource`);
  }

  return value as McpAppResourceUri;
}

export function parseMcpAppResourceUri(value: unknown): McpAppResourceUri {
  return parseResourceUri(value, 'MCP Apps resource URI');
}

export function parseMcpAppMimeType(value: unknown): typeof MCP_APPS_MIME_TYPE {
  if (value !== MCP_APPS_MIME_TYPE) {
    throw new TypeError(`MCP Apps resource MIME type must be exactly "${MCP_APPS_MIME_TYPE}"`);
  }
  return MCP_APPS_MIME_TYPE;
}

// A source expression is interpolated verbatim into a CSP string, so any
// directive or list delimiter (`;`, `,`, whitespace) or quote is rejected here
// before it can split or extend a directive.
const CSP_SOURCE_DELIMITERS = /[\s;,'"]/u;

function parseCspSource(value: string, label: string, allowWebSocket: boolean): string {
  if (value.length === 0 || value.length > MAX_URI_LENGTH || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty CSP origin`);
  }
  if (CSP_SOURCE_DELIMITERS.test(value)) {
    throw new TypeError(`${label} must not contain CSP delimiters or quotes`);
  }
  const wildcardMarker = '://*.';
  const normalized = value.includes(wildcardMarker)
    ? value.replace(wildcardMarker, '://wildcard.')
    : value;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (error: unknown) {
    throw new TypeError(`${label} must be an absolute CSP origin`, { cause: error });
  }
  const allowedProtocols = allowWebSocket
    ? ['http:', 'https:', 'ws:', 'wss:']
    : ['http:', 'https:'];
  if (
    !allowedProtocols.includes(parsed.protocol) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hostname.length === 0 ||
    parsed.pathname !== '/' ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError(`${label} must be an allowed CSP origin without credentials or a path`);
  }
  return value;
}

function parseCspSourceArray(
  value: readonly string[],
  label: string,
  allowWebSocket: boolean
): readonly string[] {
  if (value.length > MAX_METADATA_COLLECTION_ENTRIES) {
    throw new TypeError(`${label} must contain at most ${MAX_METADATA_COLLECTION_ENTRIES} entries`);
  }
  return Object.freeze(
    value.map((entry, index) => parseCspSource(entry, `${label}[${index}]`, allowWebSocket))
  );
}

const CSP_KEYS = ['baseUriDomains', 'connectDomains', 'frameDomains', 'resourceDomains'] as const;

function parseCsp(
  csp: Readonly<Partial<Record<(typeof CSP_KEYS)[number], readonly string[] | undefined>>>,
  label: string
): McpAppResourceCsp {
  const parsed: { -readonly [K in keyof McpAppResourceCsp]: McpAppResourceCsp[K] } = {};
  for (const key of CSP_KEYS) {
    const sources = csp[key];
    if (sources !== undefined) {
      parsed[key] = parseCspSourceArray(sources, `${label}.${key}`, key === 'connectDomains');
    }
  }
  return Object.freeze(parsed);
}

function parseDomain(domain: string, label: string): string {
  if (domain.length === 0 || domain.length > 253 || domain.trim() !== domain) {
    throw new TypeError(`${label} must be a non-empty bare hostname`);
  }
  let parsedDomainUrl: URL;
  try {
    parsedDomainUrl = new URL(`https://${domain}`);
  } catch (error: unknown) {
    throw new TypeError(`${label} must be a valid bare hostname`, { cause: error });
  }
  if (
    parsedDomainUrl.hostname.toLowerCase() !== domain.toLowerCase() ||
    parsedDomainUrl.port.length > 0 ||
    parsedDomainUrl.pathname !== '/' ||
    parsedDomainUrl.search.length > 0 ||
    parsedDomainUrl.hash.length > 0
  ) {
    throw new TypeError(`${label} must be a bare hostname without a scheme or path`);
  }
  return domain;
}

/** The pinned SDK schema owns the shape; the host adds CSP, hostname and size rules. */
export function parseMcpAppResourceMeta(value: unknown): McpAppResourceMeta {
  const label = 'MCP Apps resource metadata';
  const meta = parseCanonicalRecord(McpUiResourceMetaSchema, value, label);
  const parsed: { -readonly [K in keyof McpAppResourceMeta]: McpAppResourceMeta[K] } = {};
  if (meta.csp !== undefined) {
    parsed.csp = parseCsp(meta.csp, `${label}.csp`);
  }
  if (meta.permissions !== undefined) {
    // Each granted permission is an empty object; the strip check refused any field in one.
    parsed.permissions = Object.freeze(
      Object.fromEntries(Object.keys(meta.permissions).map((key) => [key, Object.freeze({})]))
    );
  }
  if (meta.domain !== undefined) {
    parsed.domain = parseDomain(meta.domain, `${label}.domain`);
  }
  if (meta.prefersBorder !== undefined) {
    parsed.prefersBorder = meta.prefersBorder;
  }
  const result = Object.freeze(parsed);
  expectEncodedSize(result, MCP_APP_MAX_METADATA_BYTES, label);
  return result;
}

export function parseMcpAppToolMeta(value: unknown): McpAppToolMeta {
  const label = 'MCP Apps tool metadata';
  const meta = parseCanonicalRecord(McpUiToolMetaSchema, value, label);
  const parsed: { -readonly [K in keyof McpAppToolMeta]: McpAppToolMeta[K] } = {};
  if (meta.resourceUri !== undefined) {
    parsed.resourceUri = parseResourceUri(meta.resourceUri, `${label}.resourceUri`);
  }
  if (meta.visibility !== undefined) {
    if (meta.visibility.length > MAX_METADATA_COLLECTION_ENTRIES) {
      throw new TypeError(
        `${label}.visibility must contain at most ${MAX_METADATA_COLLECTION_ENTRIES} entries`
      );
    }
    // The stable schema permits empty and duplicate visibility entries.
    parsed.visibility = Object.freeze([...meta.visibility]);
  }
  const result = Object.freeze(parsed);
  expectEncodedSize(result, MCP_APP_MAX_METADATA_BYTES, label);
  return result;
}
