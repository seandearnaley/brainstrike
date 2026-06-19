import type { GlobWorkspaceInput, RuntimeData, RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { fitItemsToCharBudget } from '@brainstrike/agent';
import { processFilter } from '@brainstrike/utils';
import { Minimatch } from 'minimatch';
import { walkWorkspaceRoot } from './workspace-file-walk';
import { getWorkspaceRoots, resolveWorkspaceRoot } from './workspace-roots';

export const GLOB_WORKSPACE_TOOL_ID = 'brainstrike.globWorkspace' as const;

const DEFAULT_LIMIT = 200;

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
  matches: GlobWorkspaceMatch[];
  scanLimited: boolean;
}

/**
 * Walk one workspace root via the shared {@link walkWorkspaceRoot} (canonical
 * indexer ignore policy + symlink/containment discipline + the per-root scan
 * cap), keeping files whose workspace-relative path matches the glob.
 */
async function walkRoot(args: {
  root: RuntimeWorkspaceRoot;
  matcher: Minimatch;
  includeIgnored: boolean;
}): Promise<RootWalkState> {
  const matches: GlobWorkspaceMatch[] = [];
  const { scanLimited } = await walkWorkspaceRoot({
    root: args.root,
    includeIgnored: args.includeIgnored,
    onFile: ({ relativePath }) => {
      if (args.matcher.match(relativePath)) {
        matches.push({
          path: `/${relativePath}`,
          rootId: args.root.rootId,
          rootName: args.root.displayName,
        });
      }
    },
  });
  return { matches, scanLimited };
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
