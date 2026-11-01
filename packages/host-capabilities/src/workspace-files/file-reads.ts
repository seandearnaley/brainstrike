/**
 * ADR-0029 stage 4: the Explorer's reads of live workspace roots, owned by the
 * agent host. Every read is confined to a root the host's own catalog records
 * as live, through a `SecureRoot` opened for that read and closed after it, so
 * no handle outlives the read or keeps a removed folder open.
 *
 * A read resolves its root as Main's mounted registry did:
 * - `rootId` anchors it to that live root, even for a path a nested root also contains;
 * - an absolute path whose `rootId` is not live, or that has none, goes to the
 *   deepest live root containing it (by presented or canonical path);
 * - `rootPath` binds it to exactly the root `rootId` names, at that path;
 * - realpath containment authorizes the target, and native I/O keeps the lexical
 *   relative path, so an in-root symlink is never followed.
 */
import path from 'node:path';
import type { HostFileReads, HostResults } from '@brainstrike/agent-host';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import {
  assertNativeAbsoluteReadPath,
  createNativeSecureRoot,
  isContained,
  isFileNotFoundError,
  type MountedWorkspaceRootReadAuthority,
  pathsEqual,
  projectReadDenialDiagnostic,
  readResolvedWorkspaceFile,
  resolveCanonicalRootPath,
  resolveReadAgainstMountedRoot,
  resolveValidatedReadPath,
  type SecureWorkspaceRoot,
  withReadDenialLogging,
} from '@brainstrike/assistant-service/node-workspace-services';
import { getFileTooLargeMessage, isDurableRootId } from '@brainstrike/file-system';
import { MAX_DIRECTORY_ENTRIES } from '@brainstrike/file-system/workspace-root-nodes';
import { createLogger } from '@brainstrike/logging';
import type { WorkspaceRootResolver } from '../workspace-root-cwd.ts';

const logger = createLogger('HostFileReads');

export interface HostFileReadOptions {
  /** Test seam; production opens the root with `SecureRoot`. */
  readonly openRoot?: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  readonly roots: WorkspaceRootResolver;
}

export interface HostFileReadOwner {
  /** Refuses new reads and joins the ones in flight, so no native read outlives the host. */
  close(): Promise<void>;
  readonly service: HostFileReads;
}

interface LiveRoot {
  readonly path: string;
  readonly rootId: string;
}

interface ReadRequest {
  readonly path: string;
  readonly rootId?: string | undefined;
  readonly rootPath?: string | undefined;
}

type ReadResult = HostResults['workspace/files/read'];

function invalidPath(): Error {
  return refusalError(
    'input',
    'workspace.path-invalid',
    'The requested path is invalid.',
    'Choose a file inside a connected folder.'
  );
}

function invalidRootId(message: string): Error {
  return refusalError(
    'input',
    'workspace.root-id-invalid',
    message,
    'Reconnect the folder and retry.'
  );
}

function unmounted(message: string): Error {
  return refusalError(
    'availability',
    'workspace.root-unmounted',
    message,
    'Reconnect the folder and retry.'
  );
}

function outsideEveryRoot(): Error {
  return refusalError(
    'authorization',
    'workspace.path-outside-root',
    'Path is outside every mounted workspace root.',
    'Reconnect the folder or choose a file inside a connected folder.'
  );
}

async function canonicalOrUndefined(rootPath: string): Promise<string | undefined> {
  try {
    return await resolveCanonicalRootPath(rootPath);
  } catch {
    return undefined;
  }
}

/** Deepest containing root wins, so nested roots resolve to the inner one. */
async function deepestContaining(
  roots: readonly LiveRoot[],
  requestedPath: string
): Promise<LiveRoot | undefined> {
  const normalized = path.normalize(requestedPath);
  const candidates = await Promise.all(
    roots.map(async (root) => {
      const canonical = await canonicalOrUndefined(root.path);
      const contained =
        isContained(root.path, normalized) ||
        (canonical !== undefined && isContained(canonical, normalized));
      return contained
        ? { depth: Math.max(root.path.length, canonical?.length ?? 0), root }
        : undefined;
    })
  );
  return candidates
    .filter((candidate) => candidate !== undefined)
    .sort((left, right) => right.depth - left.depth)[0]?.root;
}

/** A missing or oversized file is the Explorer's answer; any other failure stays a failure. */
function readOutcome(error: unknown): ReadResult | undefined {
  const tooLarge = getFileTooLargeMessage(error);
  if (tooLarge) {
    return { code: 'TOO_LARGE', message: tooLarge };
  }
  if (isFileNotFoundError(error)) {
    return {
      code: 'NOT_FOUND',
      message: error instanceof Error ? error.message : 'File not found',
    };
  }
  return;
}

export function createHostFileReads(options: HostFileReadOptions): HostFileReadOwner {
  const openRoot = options.openRoot ?? createNativeSecureRoot;
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;

  const liveRoots = async (): Promise<LiveRoot[]> =>
    (await options.roots.listRoots())
      .filter((root) => path.isAbsolute(root.path))
      .map((root) => ({ path: path.normalize(root.path), rootId: root.rootId }));

  /** The exact live root a bound read claims: `rootId` must name a live root. */
  const selectClaimedRoot = async (request: ReadRequest, rootPath: string): Promise<LiveRoot> => {
    assertNativeAbsoluteReadPath(rootPath, 'Claimed workspace root path');
    assertNativeAbsoluteReadPath(request.path, 'Requested file path');
    if (!isDurableRootId(request.rootId)) {
      throw invalidRootId('The workspace folder identity is invalid.');
    }
    const root = (await liveRoots()).find((candidate) => candidate.rootId === request.rootId);
    if (!root) {
      throw unmounted('The workspace folder is no longer connected.');
    }
    return root;
  };

  /** The live root a read names, by the rules in this module's header. */
  const selectRoot = async (request: ReadRequest): Promise<LiveRoot> => {
    const { path: requestedPath, rootId, rootPath } = request;
    if (requestedPath.includes('\0')) {
      throw invalidPath();
    }
    if (rootPath !== undefined) {
      return await selectClaimedRoot(request, rootPath);
    }
    if (rootId === undefined && !path.isAbsolute(requestedPath)) {
      throw invalidRootId('A relative file read needs a connected folder identity.');
    }
    const roots = await liveRoots();
    const anchored =
      rootId === undefined ? undefined : roots.find((root) => root.rootId === rootId);
    const containing =
      anchored ??
      (path.isAbsolute(requestedPath) ? await deepestContaining(roots, requestedPath) : undefined);
    if (containing) {
      return containing;
    }
    throw rootId === undefined ? outsideEveryRoot() : unmounted('Workspace root is not mounted.');
  };

  /** Opens the named root for one read, checks the bound path, and closes it after. */
  const withRoot = async <T>(
    request: ReadRequest,
    run: (authority: MountedWorkspaceRootReadAuthority) => Promise<T>
  ): Promise<T> => {
    if (closed) {
      throw refusalError(
        'availability',
        'workspace.files-closed',
        'Workspace file reads have stopped: the agent host is closing.'
      );
    }
    const pending = (async () => {
      const live = await selectRoot(request);
      let root: SecureWorkspaceRoot;
      try {
        root = await openRoot(live.path);
      } catch (cause) {
        logger.debug('A live workspace root could not be opened for a read', {
          cause,
          rootId: live.rootId,
        });
        throw unmounted('The workspace folder is not available.');
      }
      try {
        const authority: MountedWorkspaceRootReadAuthority = {
          canonicalPath: path.normalize(root.canonicalPath),
          presentationPath: live.path,
          root,
          rootId: live.rootId,
        };
        if (
          request.rootPath !== undefined &&
          !(
            pathsEqual(authority.presentationPath, request.rootPath) ||
            pathsEqual(authority.canonicalPath, request.rootPath)
          )
        ) {
          throw refusalError(
            'authorization',
            'workspace.root-mismatch',
            'The requested path does not match the connected folder.',
            'Choose a file inside the connected folder.'
          );
        }
        return await run(authority);
      } finally {
        root.close();
      }
    })();
    inFlight.add(pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(pending);
    }
  };

  const diagnostics = (request: ReadRequest): [string, string | undefined] => [
    projectReadDenialDiagnostic(request.path),
    request.rootId === undefined ? undefined : projectReadDenialDiagnostic(request.rootId),
  ];

  const service: HostFileReads = {
    'workspace/files/exists': async ({ path: requestedPath }) =>
      await withRoot({ path: requestedPath }, async (authority) => {
        try {
          await resolveReadAgainstMountedRoot(requestedPath, authority, resolveValidatedReadPath);
          return { exists: true };
        } catch (error) {
          // The realpath preflight reports a missing target as ENOENT.
          if (isFileNotFoundError(error)) {
            return { exists: false };
          }
          throw error;
        }
      }),
    'workspace/files/list': async (request) =>
      await withReadDenialLogging(logger, 'readDirectory', ...diagnostics(request), () =>
        withRoot(request, async (authority) => {
          const resolved = await resolveReadAgainstMountedRoot(
            request.path,
            authority,
            resolveValidatedReadPath
          );
          const listing = await authority.root.listDir(
            resolved.relativePath,
            MAX_DIRECTORY_ENTRIES
          );
          if (!listing) {
            throw refusalError(
              'availability',
              'workspace.directory-unavailable',
              'Directory is not accessible.',
              'Check that the folder is available, then refresh.'
            );
          }
          return {
            entries: listing.entries.map((entry) => ({
              isDirectory: entry.isDirectory,
              isFile: entry.isFile,
              isSymbolicLink: entry.isSymbolicLink,
              ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
              name: entry.name,
              ...(entry.size === undefined ? {} : { size: entry.size }),
            })),
            inspected: listing.inspected,
            rootId: authority.rootId,
            truncated: listing.truncated,
          };
        })
      ),
    'workspace/files/read': async (request) => {
      try {
        return await withReadDenialLogging(
          logger,
          request.rootPath === undefined ? 'readFile' : 'readFileByAbsolutePath',
          ...diagnostics(request),
          () =>
            withRoot(request, async (authority) => {
              const resolved = await resolveReadAgainstMountedRoot(
                request.path,
                authority,
                resolveValidatedReadPath
              );
              return { content: await readResolvedWorkspaceFile(request.path, resolved) };
            })
        );
      } catch (error) {
        const outcome = readOutcome(error);
        if (outcome) {
          return outcome;
        }
        throw error;
      }
    },
  };

  return {
    close: async () => {
      closed = true;
      await Promise.allSettled([...inFlight]);
    },
    service,
  };
}
