import type { McpHostDiagnostic, McpStableErrorCategory } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { McpBearerCredentialFailure } from './bearer-credential';

const logger = createLogger('McpLifecycleErrors');

export type McpLifecycleFailureCode =
  | 'mcp-auth-callback-timeout'
  | 'mcp-authentication-required'
  | 'mcp-bearer-authorization-conflict'
  | 'mcp-bearer-credential-malformed'
  | 'mcp-bearer-credential-missing'
  | 'mcp-bearer-credential-unreadable'
  | 'mcp-bearer-origin-mismatch'
  | 'mcp-browser-open-failed'
  | 'mcp-child-exited'
  | 'mcp-connection-failed'
  | 'mcp-package-resolution-failed'
  | 'mcp-protocol-timeout'
  | 'mcp-server-rejected'
  | 'mcp-spawn-not-found';

const FAILURE_MESSAGES = {
  'mcp-auth-callback-timeout': 'MCP authorization callback timed out',
  'mcp-authentication-required': 'MCP server requires authentication',
  'mcp-bearer-authorization-conflict':
    'MCP bearer authentication conflicts with transport authorization',
  'mcp-bearer-credential-malformed': 'MCP bearer credential is malformed',
  'mcp-bearer-credential-missing': 'MCP bearer credential is missing',
  'mcp-bearer-credential-unreadable': 'MCP bearer credential is unreadable',
  'mcp-bearer-origin-mismatch': 'MCP bearer credential cannot be sent to another origin',
  'mcp-browser-open-failed': 'MCP authorization browser could not be opened',
  'mcp-child-exited': 'MCP stdio child exited before the operation completed',
  'mcp-connection-failed': 'MCP server connection failed',
  'mcp-package-resolution-failed': 'MCP stdio package resolution failed',
  'mcp-protocol-timeout': 'MCP protocol handshake timed out',
  'mcp-server-rejected': 'MCP server rejected the request',
  'mcp-spawn-not-found': 'MCP stdio command was not found',
} satisfies Record<McpLifecycleFailureCode, string>;

export class McpLifecycleFailure extends Error {
  override readonly name = 'McpLifecycleFailure';

  constructor(
    readonly category: McpStableErrorCategory,
    readonly code: McpLifecycleFailureCode,
    options?: ErrorOptions
  ) {
    super(FAILURE_MESSAGES[code], options);
  }
}

function readCode(cause: unknown): string | undefined {
  if (!(cause && typeof cause === 'object' && 'code' in cause)) {
    return undefined;
  }
  return typeof cause.code === 'string' ? cause.code : undefined;
}

export function findBearerCredentialFailure(
  cause: unknown
): McpBearerCredentialFailure | undefined {
  if (cause instanceof McpBearerCredentialFailure) {
    return cause;
  }
  if (!(SdkError.isInstance(cause) && cause.data && typeof cause.data === 'object')) {
    return;
  }
  const nested = Reflect.get(cause.data, 'cause');
  return nested instanceof McpBearerCredentialFailure ? nested : undefined;
}

function packageResolutionFailed(diagnostics: readonly McpHostDiagnostic[]): boolean {
  return diagnostics.some(({ message }) =>
    /(?:npm (?:error )?code E404|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|could not determine executable)/iu.test(
      message
    )
  );
}

function isAuthenticationRequired(cause: unknown, code: string | undefined): boolean {
  return (
    cause instanceof UnauthorizedError ||
    (SdkHttpError.isInstance(cause) &&
      (cause.status === 401 || code === SdkErrorCode.ClientHttpAuthentication))
  );
}

function isAuthorizationDenied(cause: unknown): boolean {
  return (
    SdkHttpError.isInstance(cause) &&
    (cause.status === 403 || cause.code === SdkErrorCode.ClientHttpForbidden)
  );
}

export function classifyMcpLifecycleFailure(
  cause: unknown,
  diagnostics: readonly McpHostDiagnostic[] = []
): McpLifecycleFailure {
  if (cause instanceof McpLifecycleFailure) {
    return cause;
  }
  const bearerFailure = findBearerCredentialFailure(cause);
  if (bearerFailure) {
    return new McpLifecycleFailure(bearerFailure.category, bearerFailure.code, {
      cause: bearerFailure,
    });
  }
  const code = readCode(cause);
  if (code === 'ENOENT') {
    return new McpLifecycleFailure('configuration', 'mcp-spawn-not-found', { cause });
  }
  if (packageResolutionFailed(diagnostics)) {
    return new McpLifecycleFailure('configuration', 'mcp-package-resolution-failed', { cause });
  }
  if (code === 'browser_open_failed' || code === 'browser-open-failed') {
    return new McpLifecycleFailure('authentication', 'mcp-browser-open-failed', { cause });
  }
  if (code === 'callback_timeout' || code === 'callback-timeout') {
    return new McpLifecycleFailure('authentication', 'mcp-auth-callback-timeout', { cause });
  }
  if (
    cause instanceof Error &&
    cause.message === 'MCP stdio connection closed during initialization'
  ) {
    return new McpLifecycleFailure('connection', 'mcp-child-exited', { cause });
  }
  if (isAuthenticationRequired(cause, code)) {
    return new McpLifecycleFailure('authentication', 'mcp-authentication-required', { cause });
  }
  if (isAuthorizationDenied(cause)) {
    return new McpLifecycleFailure('authorization', 'mcp-server-rejected', { cause });
  }
  if (SdkError.isInstance(cause) && cause.code === SdkErrorCode.RequestTimeout) {
    return new McpLifecycleFailure('protocol', 'mcp-protocol-timeout', { cause });
  }
  if (ProtocolError.isInstance(cause)) {
    return new McpLifecycleFailure('operation', 'mcp-server-rejected', { cause });
  }
  if (SdkError.isInstance(cause) && cause.code === SdkErrorCode.ConnectionClosed) {
    return new McpLifecycleFailure('connection', 'mcp-child-exited', { cause });
  }
  return new McpLifecycleFailure('connection', 'mcp-connection-failed', { cause });
}

/**
 * A discarded dynamic client registration means the stored grant can no longer
 * be used, which the product already models as `authentication-required` with a
 * Connect affordance. Reporting it as a connection fault instead strands the
 * server row on a terminal error beside healthy-looking credentials (BST-1597).
 *
 * Only the generic `mcp-connection-failed` fallback is rewritten. Every other
 * classification reachable here — `mcp-browser-open-failed`,
 * `mcp-auth-callback-timeout`, `mcp-server-rejected`, `mcp-protocol-timeout`,
 * `mcp-child-exited` — already names an actionable fault, and replacing it with
 * a second Connect button would hide the only thing the user can act on.
 */
export function classifyMcpConnectFailure(
  cause: unknown,
  diagnostics: readonly McpHostDiagnostic[] | undefined,
  options: { readonly requiresReauthorization: boolean; readonly server: string }
): McpLifecycleFailure {
  const classified = classifyMcpLifecycleFailure(cause, diagnostics);
  if (!(options.requiresReauthorization && classified.code === 'mcp-connection-failed')) {
    return classified;
  }
  logger.warn('MCP OAuth connection requires explicit authorization', {
    remedy: 'reconnect-required',
    server: options.server,
  });
  return new McpLifecycleFailure('authentication', 'mcp-authentication-required', {
    cause: classified,
  });
}
