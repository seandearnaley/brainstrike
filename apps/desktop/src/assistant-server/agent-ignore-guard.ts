import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createWorkspaceIgnoreMatcher, type WorkspaceIgnoreSources } from '@brainstrike/utils';
import {
  ancestorDirectoriesBetween,
  findRepositoryRoot,
  relativePosixPrefix,
} from './repository-root';

/**
 * The HARD agent-ignore layers, queryable by arbitrary path (BST-1432).
 *
 * `createWorkspaceIgnoreMatcher` is a push/pop stack, which is the right shape
 * for a walk that descends a tree once and knows where it is. It is the WRONG
 * shape for ripgrep, which hands back a flat list of relative paths in no
 * particular order and with no directory context. This guard is that second
 * shape, over the two agent layers only.
 *
 * It exists because the hard boundary has to bind on EVERY read path, and live
 * grep has two independent candidate collectors. An exclusion enforced in only
 * one of them holds or fails depending on whether `rg` is installed — a
 * boundary with that property is not a boundary.
 *
 * WHY JS-SIDE FOR BOTH ENGINES, when `.gitignore` deliberately is not
 * (BST-1429): rg implements gitignore natively, so delegating that layer to rg
 * means two implementations that must agree on every edge case, and gitignore
 * reimplementations demonstrably do not. `.llmignore` and `.brainstrikeignore`
 * are not rg ignore files at all, so there is no second implementation to
 * diverge from — JS-side enforcement is the only one, applied identically to
 * both candidate sets.
 */
export interface AgentIgnoreGuard {
  /**
   * Whether a FILE is excluded by an agent ignore file, given its
   * workspace-relative POSIX path WITHOUT a leading slash.
   */
  ignoresFile(relativePath: string): Promise<boolean>;
}

/** Per-directory agent ignore files, lowest priority first. */
const AGENT_IGNORE_FILES = [
  ['.llmignore', 'llmignore'],
  ['.brainstrikeignore', 'brainstrikeignore'],
] as const satisfies readonly (readonly [string, keyof WorkspaceIgnoreSources])[];

/**
 * Read one agent ignore file. Absent is normal and returns undefined; ANY other
 * failure THROWS.
 *
 * This is the opposite of the walk's ignore reader, and deliberately so. There,
 * an unreadable `.gitignore` costs a wider walk, so failing open is the smaller
 * harm. Here, failing open means "I could not read the rules" resolves to
 * "there are no rules" and the protected file is served — the exact outcome the
 * boundary exists to prevent, arriving through the door marked robustness.
 * EACCES/EIO on a file the user put there to hide secrets must stop the read.
 */
async function readIgnoreFile(absolutePath: string): Promise<string | undefined> {
  try {
    return await fsPromises.readFile(absolutePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw new Error(
      `Cannot read agent ignore file "${absolutePath}": ${(error as Error).message}. Refusing to proceed, because treating it as absent would grant access it exists to deny.`,
      { cause: error }
    );
  }
}

/**
 * Ancestor directories of `relativeDirectory`, outermost first, as
 * workspace-relative POSIX paths starting with the root (''). Used to assemble
 * the scope chain a walk would have pushed on its way down.
 */
function ancestorDirectories(relativeDirectory: string): string[] {
  const chain = [''];
  if (relativeDirectory === '' || relativeDirectory === '.') {
    return chain;
  }
  let current = '';
  for (const segment of relativeDirectory.split('/')) {
    current = current === '' ? segment : `${current}/${segment}`;
    chain.push(current);
  }
  return chain;
}

export function createAgentIgnoreGuard(canonicalRootPath: string): AgentIgnoreGuard {
  // Keyed by workspace-relative directory. Promises are cached, not values, so
  // concurrent candidates resolving the same directory share ONE set of reads —
  // rg can hand back thousands of paths in one directory.
  const sourcesByDirectory = new Map<string, Promise<WorkspaceIgnoreSources>>();
  const matcherByDirectory = new Map<
    string,
    Promise<ReturnType<typeof createWorkspaceIgnoreMatcher>>
  >();

  /** Agent ignore files in one ABSOLUTE directory (used for parents). */
  const readSourcesAt = async (absolute: string): Promise<WorkspaceIgnoreSources> => {
    const sources: WorkspaceIgnoreSources = {};
    await Promise.all(
      AGENT_IGNORE_FILES.map(async ([fileName, layer]) => {
        const contents = await readIgnoreFile(path.join(absolute, fileName));
        if (contents !== undefined) {
          sources[layer] = contents;
        }
      })
    );
    return sources;
  };

  const readSources = (relativeDirectory: string): Promise<WorkspaceIgnoreSources> => {
    const cached = sourcesByDirectory.get(relativeDirectory);
    if (cached) {
      return cached;
    }
    const pending = (async () => {
      const absolute =
        relativeDirectory === ''
          ? canonicalRootPath
          : path.join(canonicalRootPath, ...relativeDirectory.split('/'));
      const sources: WorkspaceIgnoreSources = {};
      await Promise.all(
        AGENT_IGNORE_FILES.map(async ([fileName, layer]) => {
          const contents = await readIgnoreFile(path.join(absolute, fileName));
          if (contents !== undefined) {
            sources[layer] = contents;
          }
        })
      );
      return sources;
    })();
    sourcesByDirectory.set(relativeDirectory, pending);
    return pending;
  };

  /**
   * Agent ignore files in the directories ABOVE the workspace root, from the
   * enclosing repository root down. Resolved once per guard.
   *
   * Without this the boundary stopped at whatever folder the user happened to
   * open: a repo-root `.llmignore` protecting `packages/web/secrets/` did
   * nothing once `packages/web` was the root (BST-1435). The walk reads the
   * same chain, so the two agree — otherwise protection would depend on which
   * tool the model reached for.
   */
  let parentScopesPromise: Promise<{ pathPrefix: string; sources: WorkspaceIgnoreSources }[]>;
  const parentScopes = () => {
    parentScopesPromise ??= (async () => {
      const repositoryRoot = await findRepositoryRoot(canonicalRootPath);
      if (repositoryRoot === undefined) {
        return [];
      }
      const directories = ancestorDirectoriesBetween(repositoryRoot, canonicalRootPath);
      const scopes = await Promise.all(
        directories.map(async (directory) => ({
          pathPrefix: relativePosixPrefix(directory, canonicalRootPath),
          sources: await readSourcesAt(directory),
        }))
      );
      return scopes.filter((scope) => Object.keys(scope.sources).length > 0);
    })();
    return parentScopesPromise;
  };

  // A file's verdict depends only on its PARENT directory's scope chain, so the
  // assembled matcher is cached per directory rather than rebuilt per candidate.
  const matcherFor = (
    relativeDirectory: string
  ): Promise<ReturnType<typeof createWorkspaceIgnoreMatcher>> => {
    const cached = matcherByDirectory.get(relativeDirectory);
    if (cached) {
      return cached;
    }
    const pending = (async () => {
      const chain = ancestorDirectories(relativeDirectory);
      const [parents, sources] = await Promise.all([
        parentScopes(),
        Promise.all(chain.map((directory) => readSources(directory))),
      ]);
      const matcher = createWorkspaceIgnoreMatcher();
      // Outermost first: repo-root parents, then the opened root downward.
      for (const scope of parents) {
        matcher.push('', scope.sources, { pathPrefix: scope.pathPrefix });
      }
      chain.forEach((directory, index) => {
        matcher.push(directory, sources[index] ?? {});
      });
      return matcher;
    })();
    matcherByDirectory.set(relativeDirectory, pending);
    return pending;
  };

  return {
    ignoresFile: async (relativePath) => {
      // Callers disagree on the leading slash: the walk yields `src/a.ts`, the
      // read tools yield `/src/a.ts`. `ignore` treats a leading slash as an
      // absolute path and REFUSES it outright, so normalise here rather than
      // making every caller remember (the refusal surfaces as a confusing
      // `path.relative()` error, not as a missed exclusion — but a guard whose
      // correctness depends on caller punctuation is a trap either way).
      const normalized = relativePath.replace(/^\/+/, '');
      if (normalized === '') {
        return false;
      }
      const parent = path.posix.dirname(normalized);
      const matcher = await matcherFor(parent === '.' ? '' : parent);
      return matcher.ignoresFile(normalized);
    },
  };
}

/**
 * The single refusal for a direct read of an agent-ignored file.
 *
 * THROWS rather than returning empty content. A read that silently yields
 * nothing teaches the model the file is empty, and it will confidently report
 * that — a fabricated fact, and the worst possible outcome for a boundary whose
 * whole value is that the user can predict what the agent saw. The refusal
 * names the file that caused it so the user can find and edit the rule.
 */
/*
 * NO PROCESS-WIDE GUARD CACHE. It was here for one release and is deliberately
 * gone (BST-1435).
 *
 * Caching guards by root saved `2 x (depth + 1)` mostly-ENOENT opens per read,
 * and cost the only thing that matters: a `.llmignore` written AFTER the first
 * query was never seen until restart. That is not an edge case, it is the
 * primary user story — notice the agent read something, add it to
 * `.llmignore`, ask again. The justification at the time ("it cannot loosen on
 * its own") named the wrong safety property: tightening is what the user is
 * doing, and tightening is exactly what the cache dropped.
 *
 * Batch callers still share ONE guard for the duration of a single operation —
 * `dropAgentIgnored` and the excluded-path probe both construct one and query
 * it many times. That keeps the per-directory cache paying off where the reads
 * actually cluster, and bounds staleness to a single tool call rather than to
 * the lifetime of the process.
 */

export async function assertNotAgentIgnored(args: {
  canonicalRootPath: string;
  /** The path as REQUESTED (workspace-relative; a leading slash is fine). */
  relativePath: string;
  /**
   * The realpath'd file that will actually be read, when the caller has it.
   *
   * Checking only the requested path is a BYPASS, not an approximation. An
   * ordinary in-root symlink (`notes/leak.md -> ../secrets/api-key.env`) passes
   * containment, is asked about under its alias, and is then read from its
   * target. Aliasing, not retargeting — a stable-path lock does not help,
   * because the verdict is computed from a string the read never touches.
   */
  canonicalAbsolutePath?: string | undefined;
}): Promise<void> {
  const guard = createAgentIgnoreGuard(args.canonicalRootPath);
  const candidates = await agentIgnoreCandidatePaths(args);
  // Resolved together: the request and the canonical target are independent
  // queries, and either one being excluded blocks the read, so there is nothing
  // to gain by short-circuiting on the first.
  const verdicts = await Promise.all(candidates.map((candidate) => guard.ignoresFile(candidate)));
  if (verdicts.some((ignored) => ignored)) {
    throw new Error(
      `Path "${args.relativePath}" is excluded by an agent ignore file (.llmignore/.brainstrikeignore) and cannot be read.`
    );
  }
}

/**
 * Every workspace-relative path a read must clear: the request, plus the
 * canonical target when it differs (a symlink). Either being excluded blocks
 * the read — an alias must not launder an ignored file, and an ignored alias
 * must not become readable by pointing somewhere innocuous.
 */
async function agentIgnoreCandidatePaths(args: {
  canonicalRootPath: string;
  relativePath: string;
  canonicalAbsolutePath?: string | undefined;
}): Promise<string[]> {
  const candidates = [args.relativePath];
  if (args.canonicalAbsolutePath === undefined) {
    return candidates;
  }
  // The caller's root is not necessarily canonical, and comparing a canonical
  // target against a non-canonical root yields a `../…` path that matches
  // nothing — silently reopening the hole this closes.
  let canonicalRoot: string;
  try {
    canonicalRoot = await fsPromises.realpath(args.canonicalRootPath);
  } catch {
    canonicalRoot = args.canonicalRootPath;
  }
  const targetRelative = path.relative(canonicalRoot, args.canonicalAbsolutePath);
  if (targetRelative === '' || targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
    return candidates;
  }
  const posixTarget = targetRelative.split(path.sep).join('/');
  if (posixTarget !== args.relativePath.replace(/^\/+/, '')) {
    candidates.push(posixTarget);
  }
  return candidates;
}
