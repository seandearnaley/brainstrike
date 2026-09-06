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
 *   OUTSIDE it (or `..` traversal) can never escape.
 * - Outside every mounted root → `404` + logged warn (server-side audit trail
 *   only — see below).
 * - Missing/unreadable file → `404`.
 * - Outside-root and missing-file are DELIBERATELY indistinguishable to the
 *   renderer (byte-identical status + body): `realpath` runs before the
 *   containment check, so returning `403` for one and `404` for the other
 *   would let a hostile markdown file use the response code as a filesystem
 *   EXISTENCE ORACLE for arbitrary absolute paths (it can never read the
 *   bytes — this is information disclosure only, but a real one). The
 *   outside-root case is still logged via `logger.warn` so main retains the
 *   distinction for auditing; only the wire response is unified.
 * - The response is streamed from disk via `net.fetch(pathToFileURL(real))`.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '@brainstrike/logging';
import { net, protocol } from 'electron';
import { isContained } from './ipc-domains/workspace-root-paths';
import type { WorkspaceRootResolver } from './workspace-root-cwd';

const logger = createLogger('AssetProtocol');

export const ASSET_PROTOCOL_SCHEME = 'brainstrike-asset';

/**
 * Privilege descriptor for the scheme. Registered via the SINGLE
 * `protocol.registerSchemesAsPrivileged` call in `privileged-schemes.ts` —
 * Electron only honors ONE such call per launch, so no module may call it
 * directly.
 *
 * `stream` + `supportFetchAPI` let `<img>` and `fetch` consume streamed
 * responses; `bypassCSP` stays `false` so the CSP still governs where these
 * URLs may be used (the renderer's `img-src` allowlist gains the scheme).
 */
export const ASSET_PROTOCOL_PRIVILEGE = {
  privileges: {
    bypassCSP: false,
    corsEnabled: false,
    secure: true,
    standard: false,
    stream: true,
    supportFetchAPI: true,
  },
  scheme: ASSET_PROTOCOL_SCHEME,
} as const;

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
    if (isContained(rootReal, real)) {
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
      // Uniform 404 (not 403): identical to the missing-file response below so
      // this can't be used as a filesystem existence oracle. See module doc.
      return new Response('Not found', { status: 404 });
    }

    return net.fetch(pathToFileURL(real).toString());
  };
}

/** Register the `brainstrike-asset://` handler. Call AFTER the DB is ready. */
export function registerAssetProtocol(resolver: WorkspaceRootResolver): void {
  protocol.handle(ASSET_PROTOCOL_SCHEME, createAssetProtocolHandler(resolver));
  logger.info('brainstrike-asset protocol registered');
}
