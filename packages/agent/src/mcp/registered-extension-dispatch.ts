import {
  type JSONRPCMessage,
  parseJSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import type { McpClientExtensionRegistry } from './client-extension-registry';

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';
const PROTOCOL_OWNED_HEADERS = new Set([
  'accept',
  'content-type',
  'last-event-id',
  'mcp-method',
  'mcp-name',
  'mcp-protocol-version',
  'mcp-session-id',
]);

type McpHttpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

function validateConfiguredHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  for (const name of Object.keys(headers ?? {})) {
    const lowerName = name.toLowerCase();
    if (PROTOCOL_OWNED_HEADERS.has(lowerName) || lowerName.startsWith('mcp-param-')) {
      throw new Error(`Configured MCP header "${name}" is protocol-owned`);
    }
  }
}

export function createHeaderPreservingFetch(
  baseFetch: McpHttpFetch,
  headers: Readonly<Record<string, string>> | undefined,
  extensionRegistry: McpClientExtensionRegistry | undefined,
  getAuthorizationSignal?: () => AbortSignal | undefined
): McpHttpFetch {
  validateConfiguredHeaders(headers);
  const callerHeaders = new Headers(headers);
  return async (url, init) => {
    const mergedHeaders = new Headers(callerHeaders);
    const protocolHeaders = new Headers(init?.headers);
    protocolHeaders.forEach((value, name) => {
      const configuredValue = mergedHeaders.get(name);
      if (configuredValue !== null && configuredValue !== value) {
        throw new Error(
          `Configured MCP header "${name}" conflicts with the transport-required value`
        );
      }
      mergedHeaders.set(name, value);
    });
    const authorizationSignal = getAuthorizationSignal?.();
    const signal = authorizationSignal
      ? init?.signal
        ? AbortSignal.any([init.signal, authorizationSignal])
        : authorizationSignal
      : init?.signal;
    const requestInit = {
      ...init,
      headers: mergedHeaders,
      ...(signal === undefined ? {} : { signal }),
    };
    return baseFetch(url, applyRegisteredExtensionHttpHeaders(requestInit, extensionRegistry));
  };
}

function needsBase64(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX)) {
    return true;
  }
  if (value !== value.trim()) {
    return true;
  }
  for (const character of value) {
    const codeUnit = character.charCodeAt(0);
    if (codeUnit === 0x09 || (codeUnit >= 0x20 && codeUnit <= 0x7e)) {
      continue;
    }
    return true;
  }
  return false;
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

/**
 * SEP-2243 field-value encoding, source-linked to upstream SDK commit:
 * https://github.com/modelcontextprotocol/typescript-sdk/commit/70de0c8b569b0d664a56b90be2f141d1d1645880
 * Retire this copy when a released @modelcontextprotocol/client exports it.
 */
export function encodeMcpHeaderValue(value: string): string {
  if (!needsBase64(value)) {
    return value;
  }
  return `${BASE64_SENTINEL_PREFIX}${utf8ToBase64(value)}${BASE64_SENTINEL_SUFFIX}`;
}

/**
 * Installs a closed registered-extension bridge on a newly allocated, client-owned transport.
 * The SDK sees a non-colliding custom method; only an exact registered contract is rewritten to
 * its official wire method before the transport serializes it.
 */
export function installRegisteredExtensionDispatch<OwnedTransport extends Transport>(
  transport: OwnedTransport,
  registry: McpClientExtensionRegistry | undefined
): OwnedTransport {
  if (registry === undefined) {
    return transport;
  }
  const send = transport.send.bind(transport);
  transport.send = async (message, options) =>
    await send(registry.rewriteOutgoingMessage(message), options);
  return transport;
}

function parseRequestBody(body: BodyInit | null | undefined): JSONRPCMessage | undefined {
  if (typeof body !== 'string') {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  try {
    return parseJSONRPCMessage(parsed);
  } catch {
    return;
  }
}

/** Adds the extension-defined Mcp-Name standard header after SDK body serialization. */
export function applyRegisteredExtensionHttpHeaders(
  init: RequestInit | undefined,
  registry: McpClientExtensionRegistry | undefined
): RequestInit | undefined {
  if (registry === undefined) {
    return init;
  }
  const headers = new Headers(init?.headers);
  const headerMethod = headers.get('mcp-method');
  const message = parseRequestBody(init?.body);
  const candidateBodyMethod = message && 'method' in message ? message.method : undefined;
  const bodyIsRegistered =
    candidateBodyMethod !== undefined && registry.hasWireRequestMethod(candidateBodyMethod);
  const headerIsRegistered = headerMethod !== null && registry.hasWireRequestMethod(headerMethod);
  if (!(bodyIsRegistered || headerIsRegistered)) {
    return init;
  }
  if (message === undefined || !('method' in message)) {
    throw new Error('Registered MCP extension request body is missing or invalid');
  }
  const bodyMethod = message.method;
  if (headerMethod !== bodyMethod) {
    throw new Error(
      `Registered MCP extension request method/header mismatch: body=${bodyMethod}, header=${String(headerMethod)}`
    );
  }
  const name = registry.resolveMcpName(bodyMethod, message.params);
  const existingName = headers.get('mcp-name');
  if (name === undefined) {
    if (existingName !== null) {
      throw new Error(
        `Registered MCP extension request has unexpected Mcp-Name header: ${existingName}`
      );
    }
    return init;
  }
  const encodedName = encodeMcpHeaderValue(name);
  if (existingName !== null && existingName !== encodedName) {
    throw new Error(
      `Registered MCP extension request Mcp-Name mismatch: expected=${encodedName}, actual=${existingName}`
    );
  }
  headers.set('mcp-name', encodedName);
  return { ...init, headers };
}
