import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { GlobWorkspaceInput, RuntimeData, RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { fitItemsToCharBudget } from '@brainstrike/agent';
import { createBackgroundIndexingEntryPolicy, processFilter } from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import { Minimatch } from 'minimatch';
import { isWithinRoot } from './workspace-path';
import { getWorkspaceRoots, resolveWorkspaceRoot } from './workspace-roots';

const logger = createLogger('AssistantGlobWorkspaceTool');

export const GLOB_WORKSPACE_TOOL_ID = 'brainstrike.globWorkspace' as const;

const DEFAULT_LIMIT = 200;
/**
 * Hard ceiling on files visited per root, independent of `limit`. A glob with no
 * literal prefix (e.g. `**`) would otherwise enumerate an entire (large) root;
 * this bounds the walk so the tool stays responsive on the main process and
 * surfaces `scanLimited` instead of blocking. Generous enough to find every
 * real match in normal source trees.
 */
const MAX_FILES_SCANNED_PER_ROOT = 50_000;

/** A single matched file, labelled with its owning workspace root. */
export interface GlobWorkspaceMatch {
  /** Workspace-relative, POSIX-style path (rooted at the owning root). */
  path: string;
  /** Owning workspace root id (DB roots.id; matches search-result rootIds). */
  rootId: string;
  /** Owning workspace root display name. */
  rootName: string;
}

export interface GlobWorkspaceToolResult {
  /** Count of matches in this page (matches.length). */
  count: number;
  /** Actionable next step when the result was truncated or scan-limited. */
  hint?: string;
  /** Matches returned in this page (self-bounded to the output budget). */
  matches: GlobWorkspaceMatch[];
  offset: number;
  /**
   * True when at least one root's file-visit cap was hit, so more matches may
   * exist that were never reached. Never silent — surfaced for the model.
   */
  scanLimited: boolean;
  /** Total matches found across all walked roots (lower bound when scanLimited). */
  totalMatches: number;
  truncated: boolean;
}

/**
 * Compile the user's glob into a path matcher with the same conventions as the
 * file explorer's filters: dotfiles are matchable, and a bare pattern (no
 * leading `**​/` or `/`) is treated as recursive so `*.test.ts` matches at any
 * depth (via `processFilter`). Matches against workspace-relative paths WITHOUT
 * a leading slash (e.g. `src/main.ts`).
 */
function compilePatternMatcher(pattern: string): Minimatch {
  return new Minimatch(processFilter(pattern), { dot: true });
}

interface RootWalkState {
  filesScanned: number;
  matches: GlobWorkspaceMatch[];
  scanLimited: boolean;
}

type IndexingEntryPolicy = ReturnType<typeof createBackgroundIndexingEntryPolicy>;

interface RootWalkContext {
  canonicalRootPath: string;
  includeIgnored: boolean;
  matcher: Minimatch;
  policy: IndexingEntryPolicy;
  root: RuntimeWorkspaceRoot;
  state: RootWalkState;
}

/**
 * Record a regular file as a match when its workspace-relative path matches the
 * glob and (unless `includeIgnored`) the indexer ignore policy keeps it. Counts
 * every visited file against the per-root scan cap so an unbounded pattern can
 * never enumerate a giant root indefinitely.
 */
function recordFileIfMatch(ctx: RootWalkContext, name: string, childRelative: string): void {
  if (ctx.state.filesScanned >= MAX_FILES_SCANNED_PER_ROOT) {
    ctx.state.scanLimited = true;
    return;
  }
  ctx.state.filesScanned += 1;
  if (
    !(
      ctx.includeIgnored ||
      ctx.policy.shouldIncludeFile({
        fileName: name,
        fileSize: undefined,
        relativePath: childRelative,
      })
    )
  ) {
    return;
  }
  if (!ctx.matcher.match(childRelative)) {
    return;
  }
  ctx.state.matches.push({
    path: `/${childRelative}`,
    rootId: ctx.root.rootId,
    rootName: ctx.root.displayName,
  });
}

/**
 * Resolve a symlink entry: accept it only when its realpath target is a regular
 * file inside the canonical root. A symlink whose target escapes the root, or
 * resolves to a directory, is dropped — never traversed — so the walk can never
 * leave the workspace (mirrors the read/write tools' symlink discipline).
 */
async function processSymlinkEntry(
  ctx: RootWalkContext,
  name: string,
  childAbsolute: string,
  childRelative: string
): Promise<void> {
  let canonicalTarget: string;
  let targetStat: import('node:fs').Stats;
  try {
    canonicalTarget = await fsPromises.realpath(childAbsolute);
    targetStat = await fsPromises.stat(childAbsolute);
  } catch {
    return;
  }
  if (!(isWithinRoot(ctx.canonicalRootPath, canonicalTarget) && targetStat.isFile())) {
    return;
  }
  recordFileIfMatch(ctx, name, childRelative);
}

async function visitDirectory(
  ctx: RootWalkContext,
  currentAbsolutePath: string,
  relativePosix: string
): Promise<void> {
  if (ctx.state.scanLimited) {
    return;
  }

  let dirEntries: import('node:fs').Dirent[];
  try {
    dirEntries = await fsPromises.readdir(currentAbsolutePath, { withFileTypes: true });
  } catch (error) {
    logger.debug('globWorkspace: unreadable directory skipped', { path: relativePosix, error });
    return;
  }

  for (const dirent of dirEntries) {
    if (ctx.state.scanLimited) {
      return;
    }
    const childRelative =
      relativePosix.length === 0 ? dirent.name : `${relativePosix}/${dirent.name}`;
    const childAbsolute = path.join(currentAbsolutePath, dirent.name);

    if (dirent.isDirectory()) {
      // .git is never descended into even with includeIgnored (huge, opaque,
      // never useful as source); other exclusions defer to the indexer policy.
      if (dirent.name === '.git') {
        continue;
      }
      if (
        !(
          ctx.includeIgnored ||
          ctx.policy.shouldTraverseDirectory({
            directoryName: dirent.name,
            relativePath: childRelative,
          })
        )
      ) {
        continue;
      }
      await visitDirectory(ctx, childAbsolute, childRelative);
      continue;
    }

    if (dirent.isSymbolicLink()) {
      await processSymlinkEntry(ctx, dirent.name, childAbsolute, childRelative);
      continue;
    }

    if (dirent.isFile()) {
      recordFileIfMatch(ctx, dirent.name, childRelative);
    }
  }
}

/**
 * Walk one workspace root, collecting files whose workspace-relative path
 * matches `matcher`. Reuses the canonical workspace-indexer ignore policy
 * (`createBackgroundIndexingEntryPolicy`) for directory/file exclusions so glob
 * skips exactly what the indexer skips (.git, node_modules, dist/build output,
 * lockfiles, generated/minified artifacts) unless `includeIgnored` is set.
 *
 * Symlink discipline mirrors the read/write tools: symlinked directories are
 * never traversed (so the walk can never escape the root), and every matched
 * regular file is realpath-containment-checked before it is returned — a
 * symlink whose target lives outside the canonical root is dropped.
 */
async function walkRoot(args: {
  root: RuntimeWorkspaceRoot;
  matcher: Minimatch;
  includeIgnored: boolean;
}): Promise<RootWalkState> {
  const state: RootWalkState = { matches: [], filesScanned: 0, scanLimited: false };

  let canonicalRootPath: string;
  try {
    canonicalRootPath = await fsPromises.realpath(args.root.path);
  } catch (error) {
    // A root that no longer exists on disk yields zero matches for that root,
    // logged rather than failing the whole multi-root walk.
    logger.warn('globWorkspace: workspace root is not accessible', {
      rootId: args.root.rootId,
      error,
    });
    return state;
  }

  const ctx: RootWalkContext = {
    root: args.root,
    matcher: args.matcher,
    includeIgnored: args.includeIgnored,
    policy: createBackgroundIndexingEntryPolicy({ preset: 'balanced' }),
    canonicalRootPath,
    state,
  };
  await visitDirectory(ctx, canonicalRootPath, '');
  return state;
}

function buildResult(
  allMatches: readonly GlobWorkspaceMatch[],
  offset: number,
  scanLimited: boolean
): GlobWorkspaceToolResult {
  const pagedMatches = allMatches.slice(offset);
  // The hint is built INSIDE the fitted candidate so it can never push the
  // serialized result back over the budget.
  const { result } = fitItemsToCharBudget(pagedMatches, (matches): GlobWorkspaceToolResult => {
    const droppedByBudget = offset + matches.length < allMatches.length;
    const truncated = droppedByBudget || scanLimited;
    // A continuation hint must always ADVANCE: if even one match cannot fit the
    // budget, skip past it rather than re-suggesting the same offset.
    const nextOffset =
      matches.length === 0 && pagedMatches.length > 0 ? offset + 1 : offset + matches.length;
    const scanNote = scanLimited
      ? ' The walk hit its file-visit cap, so more matches may exist; narrow the pattern (e.g. a specific subdirectory) to reach them.'
      : '';
    const hint = truncated
      ? `Showing matches ${offset + 1}-${offset + matches.length} of ${allMatches.length}${scanLimited ? '+' : ''}.` +
        `${scanNote}` +
        (droppedByBudget ? ` Continue with offset: ${nextOffset}, or narrow the pattern.` : '')
      : undefined;
    return {
      matches,
      count: matches.length,
      totalMatches: allMatches.length,
      offset,
      truncated,
      scanLimited,
      ...(hint ? { hint } : {}),
    };
  });
  return result;
}

export async function runGlobWorkspace(
  input: GlobWorkspaceInput,
  runtimeData: RuntimeData | undefined
): Promise<GlobWorkspaceToolResult> {
  // An explicit `root` scopes the walk to one open folder. Resolve it BEFORE the
  // walk so an unknown/ambiguous folder surfaces its actionable "Open folders:
  // ..." message to the model. Omitting `root` enumerates every open root.
  const roots =
    input.root === undefined
      ? getWorkspaceRoots(runtimeData)
      : [resolveWorkspaceRoot(runtimeData, input.root)];
  if (roots.length === 0) {
    throw new Error(
      'No folder is open in the workspace. Add a folder in the left file tree first.'
    );
  }

  const matcher = compilePatternMatcher(input.pattern);
  const includeIgnored = input.includeIgnored === true;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  const allMatches: GlobWorkspaceMatch[] = [];
  let scanLimited = false;
  for (const root of roots) {
    const state = await walkRoot({ root, matcher, includeIgnored });
    allMatches.push(...state.matches);
    scanLimited = scanLimited || state.scanLimited;
  }

  // Stable ordering across roots: by root name, then by path.
  allMatches.sort((a, b) => a.rootName.localeCompare(b.rootName) || a.path.localeCompare(b.path));

  // Apply the user-facing `limit` (number of matches to surface) before the
  // token-budget fit, so offset+limit paging is meaningful and the budget fit
  // only trims further when even `limit` rows would overflow.
  const limited = allMatches.slice(0, offset + limit);
  const limitTruncated = allMatches.length > offset + limit;
  const result = buildResult(limited, offset, scanLimited);
  if (limitTruncated && !result.truncated) {
    const nextOffset = result.offset + result.count;
    return {
      ...result,
      totalMatches: allMatches.length,
      truncated: true,
      hint: `Showing matches ${offset + 1}-${offset + result.count} of ${allMatches.length}. Continue with offset: ${nextOffset}, or narrow the pattern.`,
    };
  }
  return { ...result, totalMatches: allMatches.length };
}
