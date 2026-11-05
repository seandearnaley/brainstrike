import process from 'node:process';
import type { RuntimeWorkspaceRoot } from '@brainstrike/assistant-contract';

/**
 * BST-764 — the ONE place `grepSearch`'s `filePaths` allowlist is interpreted.
 *
 * The defect this replaces: `runLiveGrep` normalized every allowlisted path
 * with `p.replace(/^\/+/, '')`, turning
 *
 *     /Users/sean/Documents/site-qa/proof.html
 *
 * into `Users/sean/Documents/site-qa/proof.html`, which can never equal the
 * root-relative candidate `proof.html`. The live pass then reported a clean
 * zero-match — a successful tool call with `totalMatches: 0` for a file whose
 * contents plainly matched. A hosted model read that as "native grep is
 * broken" and fell back to shell commands.
 *
 * The rule that follows: **resolve, or reject — never coerce.** A path that
 * cannot be expressed relative to a mounted root is an error with a message the
 * model can act on, never an allowlist entry that silently matches nothing. The
 * live pass matches its root-relative walk candidates against the one
 * normalized allowlist.
 */

export type GrepFilePathsResolution =
  | {
      readonly filePaths: readonly string[] | undefined;
      readonly ok: true;
      /**
       * Root ids the absolute entries resolved to, or undefined when nothing
       * pinned a root (no entries, or every entry was relative).
       *
       * Review follow-up on #2087: without this, flattening
       * `/work/A/proof.html` to `proof.html` DROPS the root the caller named,
       * so with sibling roots A and B mounted the search also matched
       * `/work/B/proof.html`. That was newly reachable — before this module the
       * absolute path simply matched nothing — and it is the same
       * silent-wrong-answer class this file exists to prevent.
       */
      readonly rootIds: readonly string[] | undefined;
    }
  | { readonly message: string; readonly ok: false };

interface ResolveGrepFilePathsArgs {
  readonly filePaths: readonly string[] | undefined;
  /** Path-backed roots the call may address. */
  readonly roots: readonly RuntimeWorkspaceRoot[];
  /** An explicit `root` (or durable thread binding) the caller already chose. */
  readonly scopedRoot: RuntimeWorkspaceRoot | undefined;
}

/**
 * POSIX `/…`, Windows drive `C:\…` / `C:/…`, UNC `\\server\share\…`, and the
 * drive-relative rooted form `\foo\bar`.
 *
 * Review follow-up on #2087: UNC and drive-relative paths previously satisfied
 * NEITHER branch, so they fell through to the relative handler, which happily
 * turned `\\server\share\file.ts` into `server/share/file.ts` — an allowlist
 * entry that can never match, reported as a clean zero-match. That is the exact
 * BST-764 failure mode on a different input shape, so these must reach the
 * reject path instead.
 */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[/\\]/u.test(value);
}

/** Backslashes to slashes, collapse runs, drop `.` segments. Keeps `..` for the caller to judge. */
function toPosixSegments(value: string): string[] {
  return value
    .replace(/\\/gu, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
}

/**
 * Collapse `..` against earlier segments. Returns null when the path climbs
 * above its own base — the traversal case, which must be rejected rather than
 * clamped at the root (clamping would silently search a file the caller did
 * not ask for).
 */
function collapseTraversal(segments: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment !== '..') {
      out.push(segment);
      continue;
    }
    if (out.length === 0) {
      return null;
    }
    out.pop();
  }
  return out;
}

function normalizeRootPath(rootPath: string): string[] {
  return toPosixSegments(rootPath);
}

/**
 * Windows path comparison is case-insensitive. Review follow-up on #2087: a
 * root recorded as `C:\Work\Repo` rejected the equivalent `c:\work\repo\x.ts`
 * as "not inside any open folder" — a loud but wrong failure, since the roots
 * come from `path.resolve` while the model's spelling comes from wherever it
 * saw the path. Only applied on win32, so POSIX stays correctly case-sensitive.
 */
const PATHS_ARE_CASE_INSENSITIVE = process.platform === 'win32';

function segmentsEqual(left: string, right: string): boolean {
  return PATHS_ARE_CASE_INSENSITIVE
    ? left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
    : left === right;
}

/** True when `pathSegments` sits at or below `rootSegments` (segment-wise, so a sibling sharing a name prefix does NOT match). */
function isWithinRoot(pathSegments: readonly string[], rootSegments: readonly string[]): boolean {
  if (pathSegments.length < rootSegments.length) {
    return false;
  }
  return rootSegments.every((segment, index) => segmentsEqual(segment, pathSegments[index] ?? ''));
}

function formatOpenRoots(roots: readonly RuntimeWorkspaceRoot[]): string {
  return roots.map((root) => `${root.displayName} (${root.path})`).join(', ');
}

function failure(message: string): GrepFilePathsResolution {
  return { message, ok: false };
}

type SinglePathResult =
  | { readonly ok: true; readonly rootId?: string; readonly value: string }
  | { readonly message: string; readonly ok: false };

/** A relative entry: only traversal and emptiness can disqualify it. */
function resolveRelativeEntry(trimmed: string): SinglePathResult {
  const collapsed = collapseTraversal(toPosixSegments(trimmed));
  if (collapsed === null) {
    return {
      message: `filePaths entry "${trimmed}" escapes the workspace with "..". Pass a path inside an open folder.`,
      ok: false,
    };
  }
  if (collapsed.length === 0) {
    return { message: `filePaths entry "${trimmed}" does not name a file.`, ok: false };
  }
  return { ok: true, value: collapsed.join('/') };
}

/** An absolute entry: must resolve to exactly one open folder, or be rejected. */
function resolveAbsoluteEntry(
  trimmed: string,
  candidateRoots: readonly RuntimeWorkspaceRoot[],
  roots: readonly RuntimeWorkspaceRoot[],
  scopedRoot: RuntimeWorkspaceRoot | undefined
): SinglePathResult {
  if (candidateRoots.length === 0) {
    return {
      message:
        `filePaths entry "${trimmed}" is an absolute path, but no open folder is available to resolve it against. ` +
        'Pass a workspace-relative path instead.',
      ok: false,
    };
  }

  const collapsed = collapseTraversal(toPosixSegments(trimmed));
  if (collapsed === null) {
    return {
      message: `filePaths entry "${trimmed}" escapes the filesystem root with "..".`,
      ok: false,
    };
  }

  const containing = candidateRoots.filter((root) =>
    isWithinRoot(collapsed, normalizeRootPath(root.path))
  );

  if (containing.length === 0) {
    const scopeNote = scopedRoot
      ? `the folder this search is scoped to, ${scopedRoot.displayName} (${scopedRoot.path})`
      : `any open folder. Open folders: ${formatOpenRoots(roots)}`;
    return {
      message:
        `filePaths entry "${trimmed}" is not inside ${scopeNote}. ` +
        'Pass a path inside an open folder, or drop filePaths to search everywhere.',
      ok: false,
    };
  }

  if (containing.length > 1) {
    // Nested roots: the same relative path would address different files
    // depending on which root it is read against. Guessing would reintroduce
    // exactly the silent-wrong-answer class this module exists to prevent.
    return {
      message:
        `filePaths entry "${trimmed}" is inside more than one open folder (${formatOpenRoots(containing)}), so its ` +
        'workspace-relative form is ambiguous. Set `root` to the folder you mean.',
      ok: false,
    };
  }

  const owningRoot = containing[0];
  if (!owningRoot) {
    // Unreachable: length was just checked. Guarded rather than asserted so a
    // future refactor cannot turn this into a silent undefined-path resolve.
    return {
      message: `filePaths entry "${trimmed}" could not be resolved to an open folder.`,
      ok: false,
    };
  }
  const relative = collapsed.slice(normalizeRootPath(owningRoot.path).length);
  if (relative.length === 0) {
    return {
      message:
        `filePaths entry "${trimmed}" is the open folder itself, not a file inside it. ` +
        'Drop filePaths to search the whole folder.',
      ok: false,
    };
  }
  // Carry the owning root so the caller can pin BOTH passes to it.
  return { ok: true, rootId: owningRoot.rootId, value: relative.join('/') };
}

export function resolveGrepFilePaths({
  filePaths,
  roots,
  scopedRoot,
}: ResolveGrepFilePathsArgs): GrepFilePathsResolution {
  if (filePaths === undefined) {
    return { filePaths: undefined, ok: true, rootIds: undefined };
  }
  // An explicitly empty allowlist means "nothing allowed" in the repository
  // layer. Upgrading it to "no filter" here would silently WIDEN the search.
  if (filePaths.length === 0) {
    return { filePaths: [], ok: true, rootIds: undefined };
  }

  // A scoped root narrows the candidate set to exactly that root; otherwise any
  // mounted root may claim the path.
  const candidateRoots = scopedRoot ? [scopedRoot] : roots;
  const resolved: string[] = [];
  const owningRootIds = new Set<string>();

  for (const rawPath of filePaths) {
    const trimmed = rawPath.trim();
    if (trimmed.length === 0) {
      return failure(
        'filePaths contains a blank entry. Every entry must be a workspace-relative file path, or an absolute path inside an open folder.'
      );
    }
    const entry = isAbsolutePath(trimmed)
      ? resolveAbsoluteEntry(trimmed, candidateRoots, roots, scopedRoot)
      : resolveRelativeEntry(trimmed);
    if (!entry.ok) {
      return failure(entry.message);
    }
    resolved.push(entry.value);
    if (entry.rootId !== undefined) {
      owningRootIds.add(entry.rootId);
    }
  }

  // Dedup while preserving first-seen order: an absolute and a relative spelling
  // of the same file must not scope the search twice.
  //
  // `rootIds` is undefined unless an ABSOLUTE entry named a root. A purely
  // relative allowlist carries no root information, so it keeps today's
  // behaviour of searching every open root.
  return {
    filePaths: [...new Set(resolved)],
    ok: true,
    rootIds: owningRootIds.size > 0 ? [...owningRootIds] : undefined,
  };
}
