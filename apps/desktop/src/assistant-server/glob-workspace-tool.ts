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
 *
 * A leading `/` is a workspace-root anchor, not a filesystem-absolute path:
 * other workspace tools surface rooted paths like `/src/main.ts`, so a rooted
 * glob such as `/src/**​/*.ts` is natural. We strip that leading slash (a
 * negation prefix `!` is preserved) BEFORE `processFilter` so the rooted form
 * compiles to the SAME matcher as the unrooted `src/**​/*.ts` — matching against
 * the slash-less relative paths the walk produces. Without this, rooted
 * patterns match nothing.
 */
function stripRootAnchor(pattern: string): string {
  if (pattern.startsWith('!')) {
    return `!${stripRootAnchor(pattern.slice(1))}`;
  }
  return pattern.startsWith('/') ? pattern.slice(1) : pattern;
}

function compilePatternMatcher(pattern: string): Minimatch {
  return new Minimatch(processFilter(stripRootAnchor(pattern)), { dot: true });
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
    root: args.root,
  });
  return { matches, scanLimited };
}

function buildResult(args: {
  /** The match window to page over (already capped to `offset + limit`). */
  windowMatches: readonly GlobWorkspaceMatch[];
  /**
   * The TRUE pre-limit total across all walked roots. Distinct from
   * `windowMatches.length` (which the user-facing `limit` may have capped), so
   * the hint's "of N" count and `totalMatches` always report the real total —
   * never the window size — and the model never under-pages.
   */
  totalMatches: number;
  offset: number;
  scanLimited: boolean;
}): GlobWorkspaceToolResult {
  const { windowMatches, totalMatches, offset, scanLimited } = args;
  const pagedMatches = windowMatches.slice(offset);
  // The hint is built INSIDE the fitted candidate so it can never push the
  // serialized result back over the budget.
  const { result } = fitItemsToCharBudget(pagedMatches, (matches): GlobWorkspaceToolResult => {
    // More matches exist than this page surfaced — either the budget trimmed
    // the window, or the `limit` capped it below the true total. Either way the
    // model can page forward, so this gates the "Continue with offset" hint.
    const moreThanPaged = offset + matches.length < totalMatches;
    const truncated = moreThanPaged || scanLimited;
    // A continuation hint must always ADVANCE: if even one match cannot fit the
    // budget, skip past it rather than re-suggesting the same offset.
    const nextOffset =
      matches.length === 0 && pagedMatches.length > 0 ? offset + 1 : offset + matches.length;
    const scanNote = scanLimited
      ? ' The walk hit its file-visit cap, so more matches may exist; narrow the pattern (e.g. a specific subdirectory) to reach them.'
      : '';
    const hint = truncated
      ? `Showing matches ${offset + 1}-${offset + matches.length} of ${totalMatches}${scanLimited ? '+' : ''}.` +
        `${scanNote}` +
        (moreThanPaged ? ` Continue with offset: ${nextOffset}, or narrow the pattern.` : '')
      : undefined;
    return {
      count: matches.length,
      matches,
      offset,
      scanLimited,
      totalMatches,
      truncated,
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
    const state = await walkRoot({ includeIgnored, matcher, root });
    allMatches.push(...state.matches);
    scanLimited = scanLimited || state.scanLimited;
  }

  // Stable ordering across roots: by root name, then by path.
  allMatches.sort((a, b) => a.rootName.localeCompare(b.rootName) || a.path.localeCompare(b.path));

  // Apply the user-facing `limit` (number of matches to surface) before the
  // token-budget fit, so offset+limit paging is meaningful and the budget fit
  // only trims further when even `limit` rows would overflow. The TRUE pre-limit
  // total is threaded through so the hint/`totalMatches` report the real total,
  // not the capped window size.
  const limited = allMatches.slice(0, offset + limit);
  return buildResult({
    offset,
    scanLimited,
    totalMatches: allMatches.length,
    windowMatches: limited,
  });
}
