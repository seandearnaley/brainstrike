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
 * Two rules follow from that, and both matter:
 *
 * 1. **Resolve, or reject — never coerce.** A path that cannot be expressed
 *    relative to a mounted root is an error with a message the model can act
 *    on, never an allowlist entry that silently matches nothing.
 * 2. **One list, both passes.** The indexed pass matches `file_records.path`
 *    and the live pass matches its root-relative walk candidates; both are
 *    root-relative, so a single normalized allowlist feeds both. Normalizing
 *    in only one of them is how they diverged in the first place.
 */

export type GrepFilePathsResolution =
  | { readonly filePaths: readonly string[] | undefined; readonly ok: true }
  | { readonly message: string; readonly ok: false };

interface ResolveGrepFilePathsArgs {
  readonly filePaths: readonly string[] | undefined;
  /** Path-backed roots the call may address. */
  readonly roots: readonly RuntimeWorkspaceRoot[];
  /** An explicit `root` (or durable thread binding) the caller already chose. */
  readonly scopedRoot: RuntimeWorkspaceRoot | undefined;
}

/** POSIX `/…` or Windows `C:\…` / `C:/…`. */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[/\\]/.test(value);
}

/** Backslashes to slashes, collapse runs, drop `.` segments. Keeps `..` for the caller to judge. */
function toPosixSegments(value: string): string[] {
  return value
    .replace(/\\/g, '/')
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

/** True when `pathSegments` sits at or below `rootSegments` (segment-wise, so a sibling sharing a name prefix does NOT match). */
function isWithinRoot(pathSegments: readonly string[], rootSegments: readonly string[]): boolean {
  if (pathSegments.length < rootSegments.length) {
    return false;
  }
  return rootSegments.every((segment, index) => segment === pathSegments[index]);
}

function formatOpenRoots(roots: readonly RuntimeWorkspaceRoot[]): string {
  return roots.map((root) => `${root.displayName} (${root.path})`).join(', ');
}

function failure(message: string): GrepFilePathsResolution {
  return { message, ok: false };
}

type SinglePathResult =
  | { readonly ok: true; readonly value: string }
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
  return { ok: true, value: relative.join('/') };
}

export function resolveGrepFilePaths({
  filePaths,
  roots,
  scopedRoot,
}: ResolveGrepFilePathsArgs): GrepFilePathsResolution {
  if (filePaths === undefined) {
    return { filePaths: undefined, ok: true };
  }
  // An explicitly empty allowlist means "nothing allowed" in the repository
  // layer. Upgrading it to "no filter" here would silently WIDEN the search.
  if (filePaths.length === 0) {
    return { filePaths: [], ok: true };
  }

  // A scoped root narrows the candidate set to exactly that root; otherwise any
  // mounted root may claim the path.
  const candidateRoots = scopedRoot ? [scopedRoot] : roots;
  const resolved: string[] = [];

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
  }

  // Dedup while preserving first-seen order: an absolute and a relative spelling
  // of the same file must not scope the search twice.
  return { filePaths: [...new Set(resolved)], ok: true };
}
