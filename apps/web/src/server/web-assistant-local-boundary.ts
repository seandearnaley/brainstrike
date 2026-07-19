import type http from 'node:http';
import { BlockList, isIP } from 'node:net';

export interface LocalAssistantRequestBoundaryError {
  readonly error: string;
  readonly message: string;
  readonly status: 403 | 415;
}

const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');

const LOOPBACK_REQUIRED_ERROR = {
  error: 'local_assistant_loopback_required',
  message: 'Local assistant API requests must originate from a loopback client.',
  status: 403,
} as const satisfies LocalAssistantRequestBoundaryError;

const HOST_FORBIDDEN_ERROR = {
  error: 'local_assistant_host_forbidden',
  message: 'Local assistant API requests require a trusted loopback Host header.',
  status: 403,
} as const satisfies LocalAssistantRequestBoundaryError;

const ORIGIN_FORBIDDEN_ERROR = {
  error: 'local_assistant_origin_forbidden',
  message: 'Local assistant API browser requests must be same-origin.',
  status: 403,
} as const satisfies LocalAssistantRequestBoundaryError;

const JSON_REQUIRED_ERROR = {
  error: 'local_assistant_json_required',
  message: 'Local assistant API POST requests require Content-Type: application/json.',
  status: 415,
} as const satisfies LocalAssistantRequestBoundaryError;

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return LOOPBACK_ADDRESSES.check(address, 'ipv4');
  }
  if (family === 6) {
    return LOOPBACK_ADDRESSES.check(address, 'ipv6');
  }
  return false;
}

function resolveTrustedRequestOrigin(req: http.IncomingMessage): string | null {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0 || host.trim() !== host) {
    return null;
  }

  let parsedHost: URL;
  try {
    parsedHost = new URL(`http://${host}`);
  } catch {
    return null;
  }

  if (
    parsedHost.username.length > 0 ||
    parsedHost.password.length > 0 ||
    parsedHost.pathname !== '/' ||
    parsedHost.search.length > 0 ||
    parsedHost.hash.length > 0
  ) {
    return null;
  }

  const hostname = parsedHost.hostname.replace(/^\[|\]$/g, '');
  if (hostname.toLowerCase() !== 'localhost' && !isLoopbackAddress(hostname)) {
    return null;
  }

  const protocol =
    (req.socket as { readonly encrypted?: unknown }).encrypted === true ? 'https:' : 'http:';
  return `${protocol}//${parsedHost.host}`;
}

function isTrustedRequestOrigin(req: http.IncomingMessage, requestOrigin: string): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    return false;
  }

  const origin = req.headers.origin;
  if (origin === undefined) {
    return true;
  }
  if (typeof origin !== 'string' || origin.length === 0 || origin.trim() !== origin) {
    return false;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  return (
    parsedOrigin.username.length === 0 &&
    parsedOrigin.password.length === 0 &&
    parsedOrigin.pathname === '/' &&
    parsedOrigin.search.length === 0 &&
    parsedOrigin.hash.length === 0 &&
    parsedOrigin.origin === requestOrigin
  );
}

function hasApplicationJsonContentType(req: http.IncomingMessage): boolean {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string') {
    return false;
  }
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * Protect the Vite-only assistant middleware, which can read a server API key
 * from the local environment. Vercel Functions enforce their separate
 * deployment boundary before reaching the shared route implementation.
 */
export function resolveLocalAssistantRequestBoundaryError(
  req: http.IncomingMessage
): LocalAssistantRequestBoundaryError | null {
  const remoteAddress = req.socket.remoteAddress;
  if (typeof remoteAddress !== 'string' || !isLoopbackAddress(remoteAddress)) {
    return LOOPBACK_REQUIRED_ERROR;
  }

  const requestOrigin = resolveTrustedRequestOrigin(req);
  if (!requestOrigin) {
    return HOST_FORBIDDEN_ERROR;
  }

  if (!isTrustedRequestOrigin(req, requestOrigin)) {
    return ORIGIN_FORBIDDEN_ERROR;
  }

  if (req.method === 'POST' && !hasApplicationJsonContentType(req)) {
    return JSON_REQUIRED_ERROR;
  }

  return null;
}
