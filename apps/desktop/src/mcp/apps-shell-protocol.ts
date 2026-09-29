/**
 * `brainstrike-mcp-app://` Electron protocol (BST-1572).
 *
 * Serves the per-mount MCP App sandbox shell: a host-authored document that
 * frames the untrusted app as an opaque-origin `srcdoc` iframe with
 * `sandbox="allow-scripts"`. The renderer renders the shell (see
 * `McpAppSandboxOwner` in `@brainstrike/mcp-app-host`) and registers it here
 * over the visible-UI `mcp:apps:prepareShell` IPC; the registry mints an
 * unguessable token and the shell is served at `brainstrike-mcp-app://<token>/`.
 *
 * Why a scheme and not a blob URL: the main window's CSP allows
 * `frame-src brainstrike-canvas: brainstrike-mcp-app:` only, and a blob shell
 * would run ON the host origin with a meta-tag policy the nested app frame
 * could not inherit as a header. Served this way the shell gets:
 * - its own origin per token (`standard: true`), never the host's;
 * - a header-delivered `Content-Security-Policy` and `Permissions-Policy`
 *   (the nested `about:srcdoc` app document inherits the header policy —
 *   `Permissions-Policy` is header-only and a meta tag would be inert);
 * - a fenced lifetime: `release` makes the URL 404 immediately, and every
 *   shell an owner registered is dropped when that WebContents is destroyed.
 *
 * Header contract (pinned by apps-shell-protocol.test.ts): NO `X-Frame-Options`
 * and NO `frame-ancestors` (the scheme exists to be framed; setup-security
 * exempts it from the global stamp). Anything but a registered shell root
 * → uniform 404; any method but GET → 405.
 */

import { randomBytes } from 'node:crypto';
import { createLogger } from '@brainstrike/logging';
import { protocol } from 'electron';

const logger = createLogger('McpAppShellProtocol');

export const MCP_APP_SHELL_PROTOCOL_SCHEME = 'brainstrike-mcp-app';

/**
 * Privilege descriptor for the scheme. Registered via the SINGLE
 * `protocol.registerSchemesAsPrivileged` call in `privileged-schemes.ts` —
 * Electron only honors ONE such call per launch, so no module may call it
 * directly. `standard: true` gives each `brainstrike-mcp-app://<token>/` a
 * real origin of its own; `bypassCSP` stays false (the renderer's
 * `frame-src brainstrike-mcp-app:` allowlist is what admits it); no fetch,
 * CORS, or streaming — the shell is a single document load.
 */
export const MCP_APP_SHELL_PROTOCOL_PRIVILEGE = {
  privileges: {
    bypassCSP: false,
    corsEnabled: false,
    secure: true,
    standard: true,
    stream: false,
    supportFetchAPI: false,
  },
  scheme: MCP_APP_SHELL_PROTOCOL_SCHEME,
} as const;

/** 16 random bytes → 32 lowercase hex characters: a valid, unguessable host label. */
const TOKEN_BYTES = 16;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/u;
const DEFAULT_MAX_SHELLS_PER_OWNER = 16;
const DEFAULT_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

export interface McpAppShellDocument {
  readonly contentSecurityPolicy: string;
  readonly document: string;
  readonly permissionsPolicy: string;
}

export interface McpAppShellLease {
  readonly shellUrl: string;
  readonly token: string;
}

interface RegisteredShell extends McpAppShellDocument {
  readonly ownerId: number;
}

interface McpAppShellRegistryOptions {
  readonly maxDocumentBytes?: number;
  readonly maxShellsPerOwner?: number;
}

function parseLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

/** Only the shell root `brainstrike-mcp-app://<token>/` is ever served. */
export function mcpAppShellUrl(token: string): string {
  if (!TOKEN_PATTERN.test(token)) {
    throw new TypeError('MCP App shell token is malformed');
  }
  return `${MCP_APP_SHELL_PROTOCOL_SCHEME}://${token}/`;
}

/**
 * Main-side registry of live shells, keyed by unguessable token and bound to
 * the WebContents id that registered them. Fails closed on limits; never
 * degrades a registration.
 */
export class McpAppShellRegistry {
  readonly #maxDocumentBytes: number;
  readonly #maxShellsPerOwner: number;
  readonly #shells = new Map<string, RegisteredShell>();
  readonly #tokensByOwner = new Map<number, Set<string>>();

  constructor(options: McpAppShellRegistryOptions = {}) {
    this.#maxDocumentBytes = parseLimit(
      options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
      'MCP App shell document byte limit'
    );
    this.#maxShellsPerOwner = parseLimit(
      options.maxShellsPerOwner ?? DEFAULT_MAX_SHELLS_PER_OWNER,
      'MCP App shell per-owner limit'
    );
  }

  get size(): number {
    return this.#shells.size;
  }

  register(ownerId: number, shell: McpAppShellDocument): McpAppShellLease {
    const owned = this.#tokensByOwner.get(ownerId) ?? new Set<string>();
    if (owned.size >= this.#maxShellsPerOwner) {
      throw new TypeError('MCP App shell per-owner limit exceeded');
    }
    if (Buffer.byteLength(shell.document, 'utf8') > this.#maxDocumentBytes) {
      throw new TypeError('MCP App shell document byte limit exceeded');
    }
    let token = randomBytes(TOKEN_BYTES).toString('hex');
    while (this.#shells.has(token)) {
      token = randomBytes(TOKEN_BYTES).toString('hex');
    }
    this.#shells.set(token, {
      contentSecurityPolicy: shell.contentSecurityPolicy,
      document: shell.document,
      ownerId,
      permissionsPolicy: shell.permissionsPolicy,
    });
    owned.add(token);
    this.#tokensByOwner.set(ownerId, owned);
    return Object.freeze({ shellUrl: mcpAppShellUrl(token), token });
  }

  /** Releases one shell; only its owner may release it. Returns whether anything was released. */
  release(ownerId: number, token: string): boolean {
    const shell = this.#shells.get(token);
    if (shell === undefined || shell.ownerId !== ownerId) {
      return false;
    }
    this.#shells.delete(token);
    const owned = this.#tokensByOwner.get(ownerId);
    owned?.delete(token);
    if (owned !== undefined && owned.size === 0) {
      this.#tokensByOwner.delete(ownerId);
    }
    return true;
  }

  /** Drops every shell an owner registered (WebContents destroyed). Returns the count. */
  releaseOwner(ownerId: number): number {
    const owned = this.#tokensByOwner.get(ownerId);
    if (owned === undefined) {
      return 0;
    }
    for (const token of owned) {
      this.#shells.delete(token);
    }
    this.#tokensByOwner.delete(ownerId);
    return owned.size;
  }

  resolve(token: string): McpAppShellDocument | undefined {
    const shell = this.#shells.get(token);
    return shell === undefined
      ? undefined
      : {
          contentSecurityPolicy: shell.contentSecurityPolicy,
          document: shell.document,
          permissionsPolicy: shell.permissionsPolicy,
        };
  }
}

let singleton: McpAppShellRegistry | undefined;

/** The process-wide registry the protocol handler and the IPC bridge share. */
export function getMcpAppShellRegistry(): McpAppShellRegistry {
  singleton ??= new McpAppShellRegistry();
  return singleton;
}

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

/** Exported separately so tests can exercise routing without Electron. */
export function createMcpAppShellProtocolHandler(
  registry: Pick<McpAppShellRegistry, 'resolve'>
): (request: Request) => Response {
  return (request) => {
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { headers: { allow: 'GET' }, status: 405 });
    }
    let requested: URL;
    try {
      requested = new URL(request.url);
    } catch {
      return notFound();
    }
    const token = requested.host;
    const isRoot = requested.pathname === '/' || requested.pathname === '';
    if (!(isRoot && TOKEN_PATTERN.test(token))) {
      logger.warn('Blocked MCP App shell request for a non-shell URL', { url: request.url });
      return notFound();
    }
    const shell = registry.resolve(token);
    if (shell === undefined) {
      return notFound();
    }
    return new Response(shell.document, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': shell.contentSecurityPolicy,
        'Content-Type': 'text/html; charset=utf-8',
        'Permissions-Policy': shell.permissionsPolicy,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
      status: 200,
    });
  };
}

/** Register the `brainstrike-mcp-app://` handler. Call after `app.whenReady()`. */
export function registerMcpAppShellProtocol(registry: Pick<McpAppShellRegistry, 'resolve'>): void {
  protocol.handle(MCP_APP_SHELL_PROTOCOL_SCHEME, createMcpAppShellProtocolHandler(registry));
  logger.info('brainstrike-mcp-app protocol registered');
}
