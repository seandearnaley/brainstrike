/**
 * Root-validated `brainstrike-asset://` Electron protocol.
 *
 * The markdown viewer (Task 8) mints image URLs of the shape
 * `brainstrike-asset://local/asset?path=<encodeURIComponent(absolutePath)>`.
 * The renderer-supplied `path` is HOSTILE input: the only trust boundary is
 * containment inside a currently-mounted workspace root (the DB `roots` table —
 * the same source the git/read/search tools validate against).
 *
 * Security invariants (non-negotiable):
 * - An absolute path is required (`400` otherwise).
 * - Both the requested file AND each candidate root are `realpath`-canonicalized
 *   before the containment comparison, so a symlink inside a root that points
 *   OUTSIDE it (or `..` traversal) can never escape (`403`).
 * - An unresolvable root is SKIPPED, never treated as a match — it can only ever
 *   narrow access, never widen it.
 * - Outside every mounted root → `403` + logged warn.
 * - Missing/unreadable file → `404`.
 * - The response is streamed from disk via `net.fetch(pathToFileURL(real))`.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '@brainstrike/utils/logger';
import { net, protocol } from 'electron';
import type { WorkspaceRootResolver } from './workspace-root-cwd';

const logger = createLogger('AssetProtocol');

export const ASSET_PROTOCOL_SCHEME = 'brainstrike-asset';

/**
 * Register the scheme's privileges. MUST run before `app.whenReady()`.
 *
 * `stream` + `supportFetchAPI` let `<img>` and `fetch` consume streamed
 * responses; `bypassCSP` stays `false` so the CSP still governs where these
 * URLs may be used (the renderer's `img-src` allowlist gains the scheme).
 */
export function registerAssetProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      privileges: {
        bypassCSP: false,
        corsEnabled: false,
        secure: true,
        standard: false,
        stream: true,
        supportFetchAPI: true,
      },
      scheme: ASSET_PROTOCOL_SCHEME,
    },
  ]);
}

/**
 * Is the already-canonicalized `real` path contained in ANY mounted root?
 *
 * Each root is `realpath`-canonicalized before comparison so a symlink can
 * never widen a root. Web / FSA roots (no absolute path) and unresolvable roots
 * (unmounted volume) are SKIPPED — skipping can only narrow access, never widen.
 */
async function isContainedInAnyRoot(
  real: string,
  resolver: WorkspaceRootResolver
): Promise<boolean> {
  const roots = await resolver.listRoots();
  for (const root of roots) {
    if (!(root.path && path.isAbsolute(root.path))) {
      continue;
    }
    let rootReal: string;
    try {
      rootReal = await realpath(root.path);
    } catch {
      continue;
    }
    if (real === rootReal || real.startsWith(rootReal + path.sep)) {
      return true;
    }
  }
  return false;
}

/** Parse the renderer-supplied absolute `?path=` param, or `null` if invalid. */
function parseRequestedPath(url: string): string | null {
  let requested: string | null;
  try {
    requested = new URL(url).searchParams.get('path');
  } catch {
    return null;
  }
  return requested && path.isAbsolute(requested) ? requested : null;
}

/**
 * Build the protocol request handler. Exported separately from
 * {@link registerAssetProtocol} so tests can exercise the containment logic
 * without Electron's `protocol` module.
 */
export function createAssetProtocolHandler(
  resolver: WorkspaceRootResolver
): (request: Request) => Promise<Response> {
  return async (request) => {
    const requested = parseRequestedPath(request.url);
    if (!requested) {
      return new Response('Bad request: absolute path parameter required', { status: 400 });
    }

    let real: string;
    try {
      real = await realpath(requested);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    if (!(await isContainedInAnyRoot(real, resolver))) {
      logger.warn('Blocked asset request outside mounted roots', { requested });
      return new Response('Forbidden', { status: 403 });
    }

    return net.fetch(pathToFileURL(real).toString());
  };
}

/** Register the `brainstrike-asset://` handler. Call AFTER the DB is ready. */
export function registerAssetProtocol(resolver: WorkspaceRootResolver): void {
  protocol.handle(ASSET_PROTOCOL_SCHEME, createAssetProtocolHandler(resolver));
  logger.info('brainstrike-asset protocol registered');
}
