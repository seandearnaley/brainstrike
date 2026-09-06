import { MCP_APPS_MIME_TYPE } from './capabilities.js';
import {
  expectEncodedSize,
  expectExactKeys,
  expectRecord,
  MCP_APP_MAX_METADATA_BYTES,
} from './validation.js';

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

function isToolVisibility(value: unknown): value is McpAppToolVisibility {
  return value === 'model' || value === 'app';
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
  value: unknown,
  label: string,
  allowWebSocket: boolean
): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  if (value.length > MAX_METADATA_COLLECTION_ENTRIES) {
    throw new TypeError(`${label} must contain at most ${MAX_METADATA_COLLECTION_ENTRIES} entries`);
  }
  return Object.freeze(
    value.map((entry, index) => parseCspSource(entry, `${label}[${index}]`, allowWebSocket))
  );
}

function parseCsp(value: unknown, label: string): McpAppResourceCsp {
  const record = expectRecord(value, label);
  const keys = ['baseUriDomains', 'connectDomains', 'frameDomains', 'resourceDomains'] as const;
  expectExactKeys(record, keys, [], label);

  const parsed: {
    baseUriDomains?: readonly string[];
    connectDomains?: readonly string[];
    frameDomains?: readonly string[];
    resourceDomains?: readonly string[];
  } = {};
  for (const key of keys) {
    if (record[key] !== undefined) {
      parsed[key] = parseCspSourceArray(record[key], `${label}.${key}`, key === 'connectDomains');
    }
  }
  return Object.freeze(parsed);
}

function parseEmptyPermission(value: unknown, label: string): Readonly<Record<string, never>> {
  const record = expectRecord(value, label);
  expectExactKeys(record, [], [], label);
  return Object.freeze({});
}

function parsePermissions(value: unknown, label: string): McpAppResourcePermissions {
  const record = expectRecord(value, label);
  const keys = ['camera', 'clipboardWrite', 'geolocation', 'microphone'] as const;
  expectExactKeys(record, keys, [], label);

  const parsed: {
    camera?: Readonly<Record<string, never>>;
    clipboardWrite?: Readonly<Record<string, never>>;
    geolocation?: Readonly<Record<string, never>>;
    microphone?: Readonly<Record<string, never>>;
  } = {};
  for (const key of keys) {
    if (record[key] !== undefined) {
      parsed[key] = parseEmptyPermission(record[key], `${label}.${key}`);
    }
  }
  return Object.freeze(parsed);
}

export function parseMcpAppResourceMeta(value: unknown): McpAppResourceMeta {
  const label = 'MCP Apps resource metadata';
  const record = expectRecord(value, label);
  expectExactKeys(record, ['csp', 'domain', 'permissions', 'prefersBorder'], [], label);

  const parsed: {
    csp?: McpAppResourceCsp;
    domain?: string;
    permissions?: McpAppResourcePermissions;
    prefersBorder?: boolean;
  } = {};
  if (record['csp'] !== undefined) {
    parsed.csp = parseCsp(record['csp'], `${label}.csp`);
  }
  if (record['permissions'] !== undefined) {
    parsed.permissions = parsePermissions(record['permissions'], `${label}.permissions`);
  }
  if (record['domain'] !== undefined) {
    const domain = record['domain'];
    if (
      typeof domain !== 'string' ||
      domain.length === 0 ||
      domain.length > 253 ||
      domain.trim() !== domain
    ) {
      throw new TypeError(`${label}.domain must be a non-empty bare hostname`);
    }
    let parsedDomainUrl: URL;
    try {
      parsedDomainUrl = new URL(`https://${domain}`);
    } catch (error: unknown) {
      throw new TypeError(`${label}.domain must be a valid bare hostname`, { cause: error });
    }
    if (
      parsedDomainUrl.hostname.toLowerCase() !== domain.toLowerCase() ||
      parsedDomainUrl.port.length > 0 ||
      parsedDomainUrl.pathname !== '/' ||
      parsedDomainUrl.search.length > 0 ||
      parsedDomainUrl.hash.length > 0
    ) {
      throw new TypeError(`${label}.domain must be a bare hostname without a scheme or path`);
    }
    parsed.domain = domain;
  }
  if (record['prefersBorder'] !== undefined) {
    if (typeof record['prefersBorder'] !== 'boolean') {
      throw new TypeError(`${label}.prefersBorder must be a boolean`);
    }
    parsed.prefersBorder = record['prefersBorder'];
  }
  const result = Object.freeze(parsed);
  expectEncodedSize(result, MCP_APP_MAX_METADATA_BYTES, label);
  return result;
}

export function parseMcpAppToolMeta(value: unknown): McpAppToolMeta {
  const label = 'MCP Apps tool metadata';
  const record = expectRecord(value, label);
  expectExactKeys(record, ['resourceUri', 'visibility'], [], label);

  const parsed: {
    resourceUri?: McpAppResourceUri;
    visibility?: readonly McpAppToolVisibility[];
  } = {};
  if (record['resourceUri'] !== undefined) {
    parsed.resourceUri = parseResourceUri(record['resourceUri'], `${label}.resourceUri`);
  }
  if (record['visibility'] !== undefined) {
    const visibility = record['visibility'];
    if (!(Array.isArray(visibility) && visibility.every(isToolVisibility))) {
      throw new TypeError(`${label}.visibility must contain only "model" or "app"`);
    }
    if (visibility.length > MAX_METADATA_COLLECTION_ENTRIES) {
      throw new TypeError(
        `${label}.visibility must contain at most ${MAX_METADATA_COLLECTION_ENTRIES} entries`
      );
    }
    // The stable schema permits empty and duplicate visibility entries.
    parsed.visibility = Object.freeze([...visibility]);
  }
  const result = Object.freeze(parsed);
  expectEncodedSize(result, MCP_APP_MAX_METADATA_BYTES, label);
  return result;
}
