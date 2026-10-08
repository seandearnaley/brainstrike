import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import {
  createBackgroundIndexingEntryPolicy,
  createWorkspaceIgnoreMatcher,
  type WorkspaceIgnoreMatcher,
  type WorkspaceIgnoreSources,
} from '@brainstrike/utils';
import {
  ancestorDirectoriesBetween,
  findRepositoryRoot,
  relativePosixPrefix,
} from './repository-root.js';
import { isWithinRoot } from './workspace-path.js';

const logger = createLogger('AssistantWorkspaceFileWalk');
const execFileAsync = promisify(execFile);

/**
 * Hard ceiling on files visited per root, independent of any caller limit. An
 * unbounded walk would otherwise enumerate an entire (large) root; this bounds
 * the walk so callers stay responsive on the main process and surface
 * `scanLimited` instead of blocking. Generous enough to find every real match in
 * normal source trees.
 */
export const MAX_FILES_WALKED_PER_ROOT = 50_000;

/** A regular file discovered by the walk, kept after the ignore/containment checks. */
export interface WalkedFile {
  /** Absolute, canonical filesystem path (symlinks resolved). */
  absolutePath: string;
  /** Workspace-relative, POSIX-style path WITHOUT a leading slash (e.g. `src/main.ts`). */
  relativePath: string;
}

export interface WalkRootOptions {
  /**
   * Include files normally excluded (.git, node_modules, dist/build output,
   * lockfiles, minified/generated artifacts). Default false: the same exclusions
   * the workspace indexer applies. `.git` is never descended into regardless.
   */
  includeIgnored?: boolean;
  /**
   * Invoked for each path the walk EXCLUDED — a pruned directory or a dropped
   * file — with its workspace-relative POSIX path.
   *
   * Exists so a caller can tell "nothing matched because nothing is there" from
   * "nothing matched because what you asked for is excluded". Without it a glob
   * for an excluded path returns a bare `0 matches`, which is the silent
   * failure this walk change exists to remove, not a new place to reintroduce
   * it. `isDirectory` distinguishes the two cases a caller must treat
   * differently: a pruned DIRECTORY is reported INSTEAD of its contents (the
   * walk never descends), so it is only a PREFIX of whatever it holds, while an
   * excluded FILE is the whole path.
   */
  onExcluded?: (relativePath: string, isDirectory: boolean) => void;
  /** Invoked once per kept regular file. */
  onFile: (file: WalkedFile) => void;
  /**
   * Honour the BYPASSABLE ignore layers (global excludes, `.git/info/exclude`,
   * parent and nested `.gitignore`, `.ignore`, `.rgignore`) in addition to the
   * static policy (BST-1427). OPT-IN, and deliberately not the default.
   *
   * It does NOT gate the agent layers. `.llmignore` and `.brainstrikeignore`
   * bind on every walk regardless, because they are a security boundary and a
   * caller that forgets a flag must not silently lose one (BST-1432).
   *
   * The glob tool sets it: a denylist of directory names cannot keep up with
   * the caches a real machine accumulates, and when it falls behind the failure
   * is silent (`0 matches`, not an error).
   *
   * LIVE GREP DELIBERATELY DOES NOT. Its ripgrep pass runs `--no-ignore
   * --hidden` so the rg candidate set is a true SUPERSET, leaving the static
   * policy as the SINGLE authority that trims both engines identically —
   * without that, results would differ depending on whether rg is installed.
   * Honouring `.gitignore` on the JS side alone would break exactly that
   * parity, and honouring it on BOTH would mean rg's native gitignore
   * implementation and the `ignore` package agreeing on every edge case, which
   * gitignore reimplementations demonstrably do not. Making grep gitignore-aware
   * is therefore its own change, not a flag flip (BST-1429).
   */
  respectGitignore?: boolean;
  root: RuntimeWorkspaceRoot;
}

export interface WalkRootResult {
  /** Regular files visited (against the per-root cap), whether or not kept. */
  filesScanned: number;
  /** True when the per-root file-visit cap was hit (more files may exist, unreached). */
  scanLimited: boolean;
}

type IndexingEntryPolicy = ReturnType<typeof createBackgroundIndexingEntryPolicy>;

/**
 * Resolve the excludes file `core.excludesFile` names, or git's documented
 * default `$XDG_CONFIG_HOME/git/ignore` (falling back to `~/.config/git/ignore`).
 *
 * Resolved WITH `cwd` set to the workspace root, deliberately. `git config
 * --get` merges system + global + LOCAL config for whatever directory it runs
 * in, and Electron main's cwd is the launch directory — often `/` for a
 * packaged app, the dev checkout otherwise. Without `cwd` this consulted a
 * repo-local setting belonging to a directory unrelated to the walk while
 * ignoring the workspace root's own. Running it at the root makes it the
 * ripgrep-equivalent behaviour: whatever git would use FOR THIS TREE.
 *
 * MEMOISED per root, because it spawns a subprocess and is awaited before the
 * walk starts — it accounted for most of the walk's measured regression, on a
 * value that changes about as often as a dotfile is edited.
 */
const globalExcludesByRoot = new Map<string, Promise<string | undefined>>();

async function readGlobalExcludes(canonicalRootPath: string): Promise<string | undefined> {
  const cached = globalExcludesByRoot.get(canonicalRootPath);
  if (cached) {
    return await cached;
  }
  const pending = (async () => {
    const configured = await readGitConfigValue(['config', '--get', 'core.excludesFile'], {
      cwd: canonicalRootPath,
    });
    if (configured) {
      return await readIgnoreFile(expandHome(configured));
    }
    const base = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
    return await readIgnoreFile(path.join(base, 'git', 'ignore'));
  })();
  globalExcludesByRoot.set(canonicalRootPath, pending);
  return await pending;
}

/** Drop the memoised excludes lookups (tests, and factory reset). */
export function resetGlobalExcludesCacheForTests(): void {
  globalExcludesByRoot.clear();
}

/**
 * Run one `git` query, or undefined when git is unavailable/errors. Never
 * throws: a missing git is a wider walk, not a failure.
 */
async function readGitConfigValue(
  args: readonly string[],
  options: { cwd: string }
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd: options.cwd,
      timeout: 2000,
    });
    const value = stdout.trim();
    return value === '' ? undefined : value;
  } catch {
    return;
  }
}

function expandHome(target: string): string {
  return target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;
}

/**
 * One ignore scope that lives at or ABOVE the walk root.
 *
 * `pathPrefix` is empty when the file's directory IS the walk root, and
 * otherwise the walk root's path relative to that directory — see
 * `ScopePushOptions.pathPrefix` for why a prefix rather than rewritten patterns.
 */
interface RootChainScope {
  readonly pathPrefix: string;
  readonly sources: WorkspaceIgnoreSources;
}

interface RootIgnoreChain {
  /**
   * Sources whose base IS the walk root, to be merged into the root's own
   * scope rather than pushed beside it (see {@link mergeIgnoreSources}).
   */
  readonly merged: WorkspaceIgnoreSources;
  /** Scopes based ABOVE the walk root, outermost first. */
  readonly prefixed: readonly RootChainScope[];
}

/**
 * Git's own chain beneath whatever the opened tree declares: machine-wide
 * excludes, repo-local `.git/info/exclude`, and the `.gitignore`s BETWEEN the
 * repository root and this workspace root — which still apply when a folder is
 * opened inside a larger repo, as ripgrep honours by default.
 *
 * Each parent file keeps its OWN base. Concatenating them into the root scope
 * silently broke every slash-containing pattern: `workspace/vendor/` in
 * `/repo/.gitignore` was tested against the `vendor/x.ts` the walk produces and
 * matched nothing, so git ignored the file and we listed it.
 *
 * Cross-boundary `!` re-includes are resolved by the shared matcher's
 * path-addressable component evaluator (BST-1434). Parent sources still keep
 * separate matchers because their patterns are anchored elsewhere; the matcher
 * asks the parser about each directory component so a deeper directory
 * negation can overturn the inherited directory verdict without rewriting any
 * ignore syntax.
 */
async function readRootIgnoreChain(
  canonicalRootPath: string,
  respectGitignore: boolean
): Promise<RootIgnoreChain> {
  const merged: WorkspaceIgnoreSources = {};
  const prefixed: RootChainScope[] = [];

  // Repo-root discovery is a stat walk and always runs, because the AGENT
  // layers inherit from parents unconditionally. The git-config lookups below
  // spawn subprocesses and stay gated: live grep walks without
  // `respectGitignore` on every query, and must not pay for them.
  const [globalExcludes, repositoryRoot] = await Promise.all([
    respectGitignore ? readGlobalExcludes(canonicalRootPath) : undefined,
    findRepositoryRoot(canonicalRootPath),
  ]);
  if (repositoryRoot === undefined) {
    if (globalExcludes !== undefined) {
      merged.globalExcludes = globalExcludes;
    }
    return { merged, prefixed };
  }

  const infoExclude = respectGitignore
    ? await readRepositoryInfoExclude(repositoryRoot)
    : undefined;
  const repoPrefix = relativePosixPrefix(repositoryRoot, canonicalRootPath);
  // Global excludes and `info/exclude` are anchored at the repository, so they
  // join the root scope only when the two coincide.
  const repoScoped: WorkspaceIgnoreSources = {};
  if (globalExcludes !== undefined) {
    repoScoped.globalExcludes = globalExcludes;
  }
  if (infoExclude !== undefined) {
    repoScoped.infoExclude = infoExclude;
  }
  if (repoPrefix === '') {
    Object.assign(merged, repoScoped);
  } else if (Object.keys(repoScoped).length > 0) {
    prefixed.push({ pathPrefix: repoPrefix, sources: repoScoped });
  }

  for (const parent of await readParentGitignoreScopes(
    repositoryRoot,
    canonicalRootPath,
    respectGitignore
  )) {
    prefixed.push(parent);
  }
  return { merged, prefixed };
}

/**
 * `.git/info/exclude` via git's own gitdir resolution.
 *
 * In a linked worktree or a submodule `.git` is a FILE pointing at the real
 * gitdir, so `<repo>/.git/info/exclude` does not exist and the advertised layer
 * silently vanishes — on a repo like this one, where worktrees are routine.
 */
async function readRepositoryInfoExclude(repositoryRoot: string): Promise<string | undefined> {
  const gitPath = await readGitConfigValue(['rev-parse', '--git-path', 'info/exclude'], {
    cwd: repositoryRoot,
  });
  const resolved =
    gitPath === undefined
      ? path.join(repositoryRoot, '.git', 'info', 'exclude')
      : path.resolve(repositoryRoot, gitPath);
  return await readIgnoreFile(resolved);
}

/** One scope per parent directory, from the repo root down to (not including) the walk root. */
async function readParentGitignoreScopes(
  repositoryRoot: string,
  canonicalRootPath: string,
  respectGitignore: boolean
): Promise<RootChainScope[]> {
  const directories = ancestorDirectoriesBetween(repositoryRoot, canonicalRootPath);
  const scopes = await Promise.all(
    directories.map(async (directory): Promise<RootChainScope | undefined> => {
      const sources = await readParentIgnoreSources(directory, respectGitignore);
      return sources === undefined
        ? undefined
        : { pathPrefix: relativePosixPrefix(directory, canonicalRootPath), sources };
    })
  );
  return scopes.filter((scope): scope is RootChainScope => scope !== undefined);
}

/**
 * The ignore files ONE parent directory contributes.
 *
 * Reads the AGENT files as well as `.gitignore`, which the first version did
 * not — so a repo-root `.llmignore` protecting `packages/web/secrets/` did
 * nothing at all once `packages/web` was opened as a workspace root, with no
 * way for the user to see that (BST-1435). Inherited protection is the normal
 * way a team ships one: at the repo root, covering everything beneath it.
 *
 * The agent files bind regardless of `respectGitignore`, exactly as they do
 * per-directory inside the root.
 */
async function readParentIgnoreSources(
  directory: string,
  respectGitignore: boolean
): Promise<WorkspaceIgnoreSources | undefined> {
  const [gitignore, llmignore, brainstrikeignore] = await Promise.all([
    respectGitignore ? readIgnoreFile(path.join(directory, '.gitignore')) : undefined,
    readAgentIgnoreFile(path.join(directory, '.llmignore'), 'a parent directory (.llmignore)'),
    readAgentIgnoreFile(
      path.join(directory, '.brainstrikeignore'),
      'a parent directory (.brainstrikeignore)'
    ),
  ]);
  const sources: WorkspaceIgnoreSources = {};
  if (gitignore !== undefined) {
    sources.gitignore = gitignore;
  }
  if (llmignore !== undefined) {
    sources.llmignore = llmignore;
  }
  if (brainstrikeignore !== undefined) {
    sources.brainstrikeignore = brainstrikeignore;
  }
  return Object.keys(sources).length > 0 ? sources : undefined;
}

/**
 * Ignore files a directory may declare, mapped to the matcher layer they feed.
 * The walk already holds the directory listing, so detecting all of them costs
 * nothing beyond the reads for the ones that exist.
 */
/** The layers that bind regardless of `respectGitignore`. */
const AGENT_IGNORE_LAYERS: ReadonlySet<keyof WorkspaceIgnoreSources> = new Set([
  'llmignore',
  'brainstrikeignore',
]);

const PER_DIRECTORY_IGNORE_FILES = [
  ['.gitignore', 'gitignore'],
  ['.ignore', 'ignore'],
  ['.rgignore', 'rgignore'],
  ['.llmignore', 'llmignore'],
  ['.brainstrikeignore', 'brainstrikeignore'],
] as const satisfies readonly (readonly [string, keyof WorkspaceIgnoreSources])[];

/**
 * Read a BYPASSABLE ignore file, returning undefined when absent or unreadable.
 * An unreadable one must never fail the walk: the static policy floor still
 * applies, so the worst case is a WIDER walk, not a broken one.
 *
 * NOT for the agent layers — see {@link readAgentIgnoreFile}, where a wider
 * walk is precisely the harm.
 *
 * It must not be SILENT either. A real failure (permissions, a transient FS
 * error, a file deleted between listing and read) disables that scope's rules
 * and broadens the walk, which can reintroduce the scan-cap starvation this
 * exists to prevent while returning ordinary-looking results. ENOENT is the
 * exception and is deliberately quiet: most of these paths are probed
 * speculatively (`~/.config/git/ignore`, `.git/info/exclude`, every parent
 * `.gitignore`), so an absent file is the ordinary case, not a fault.
 */
async function readIgnoreFile(absolutePath: string): Promise<string | undefined> {
  try {
    return await fsPromises.readFile(absolutePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('workspace walk: ignore file present but unreadable; its rules are NOT applied', {
        error,
        path: absolutePath,
      });
    }
    return;
  }
}

/**
 * Read an AGENT ignore file. Absent — or not a REGULAR FILE — returns
 * undefined; any other failure THROWS and aborts the operation.
 *
 * The opposite of {@link readIgnoreFile}, and the asymmetry is the point.
 * Failing open on `.gitignore` costs a wider walk. Failing open on `.llmignore`
 * means the file the user marked "never read" is listed, indexed, and sent.
 *
 * THE `lstat` IS LOAD-BEARING, not defensive. Without it, fail-closed turns
 * harmless on-disk states into a workspace that cannot be used at all and
 * cannot be repaired from inside the app:
 *   - a DIRECTORY named `.llmignore` -> `readFile` gives EISDIR -> every glob,
 *     grep and guarded read in that workspace fails, permanently;
 *   - a FIFO named `.llmignore` -> `readFile` blocks until a writer appears,
 *     hanging the tool call with no timeout on this path.
 * Neither can carry rules, so both are ABSENT rather than unreadable. This is
 * the same discipline `readDirectoryIgnoreSources` applies inside the root via
 * `dirent.isFile()`; the parent chain has no dirent, so it lstats instead.
 */
async function readAgentIgnoreFile(
  absolutePath: string,
  displayName: string
): Promise<string | undefined> {
  try {
    // `stat`, NOT `lstat`: a SYMLINKED agent ignore file must be honoured. Users
    // manage dotfiles by symlinking them to a shared config, and skipping those
    // silently means the file they wrote to protect secrets protects nothing —
    // the same class of failure this whole ticket is about. Following the link
    // still rejects a directory or FIFO (and a symlink to one), so the brick
    // and the hang stay closed.
    const stat = await fsPromises.stat(absolutePath);
    if (!stat.isFile()) {
      return;
    }
  } catch (error) {
    if (isAbsentErrorCode(error)) {
      return;
    }
    throw agentIgnoreUnreadable(displayName, error);
  }
  try {
    return await fsPromises.readFile(absolutePath, 'utf8');
  } catch (error) {
    if (isAbsentErrorCode(error)) {
      return;
    }
    throw agentIgnoreUnreadable(displayName, error);
  }
}

/** Errors that mean "there is no ignore file here", as opposed to "I could not read it". */
function isAbsentErrorCode(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

/**
 * The refusal for an unreadable agent ignore file.
 *
 * `displayName` is NEVER an absolute path. This message is returned to the
 * model and therefore reaches the provider, and a parent-chain file can sit
 * entirely outside the workspace (`/Users/alice/private-work/.llmignore`).
 * Callers pass a workspace-relative path, or a bare description for parents.
 */
function agentIgnoreUnreadable(displayName: string, cause: unknown): Error {
  return new Error(
    `Cannot read the agent ignore file at ${displayName} (${(cause as NodeJS.ErrnoException).code ?? 'unknown error'}). Refusing to continue, because proceeding would surface files it exists to exclude.`,
    { cause }
  );
}

/**
 * Collect the ignore files this directory declares. Only names actually present
 * in the listing are read.
 */
async function readDirectoryIgnoreSources(
  directoryAbsolutePath: string,
  dirEntries: readonly import('node:fs').Dirent[],
  respectGitignore: boolean,
  relativePosix: string
): Promise<WorkspaceIgnoreSources | undefined> {
  const candidates = respectGitignore
    ? PER_DIRECTORY_IGNORE_FILES
    : PER_DIRECTORY_IGNORE_FILES.filter(([, layer]) => AGENT_IGNORE_LAYERS.has(layer));
  const present = candidates.filter(([fileName, layer]) =>
    dirEntries.some((dirent) => {
      if (dirent.name !== fileName) {
        return false;
      }
      // For the BYPASSABLE layers: isFile(), NOT !isDirectory(). A FIFO with
      // one of these names would block the read until a writer appeared, and a
      // symlink would source rules from outside the canonical root.
      //
      // For the AGENT layers the dirent gate is deliberately skipped: it is
      // lstat-based, so it drops a SYMLINKED `.llmignore` before the reader
      // ever sees it, and a symlinked dotfile is how people share one.
      // `readAgentIgnoreFile` stats through the link and still rejects a
      // directory or FIFO, so nothing is loosened.
      return AGENT_IGNORE_LAYERS.has(layer) || dirent.isFile();
    })
  );
  if (present.length === 0) {
    return;
  }
  const sources: WorkspaceIgnoreSources = {};
  await Promise.all(
    present.map(async ([fileName, key]) => {
      const absolute = path.join(directoryAbsolutePath, fileName);
      const contents = AGENT_IGNORE_LAYERS.has(key)
        ? await readAgentIgnoreFile(
            absolute,
            `${relativePosix === '' ? '' : `${relativePosix}/`}${fileName}`
          )
        : await readIgnoreFile(absolute);
      if (contents !== undefined) {
        sources[key] = contents;
      }
    })
  );
  return sources;
}

interface WalkContext {
  canonicalRootPath: string;
  filesScanned: number;
  /** Layered ignore scopes, present only when the caller opted in. */
  ignores?: WorkspaceIgnoreMatcher;
  includeIgnored: boolean;
  onExcluded: ((relativePath: string, isDirectory: boolean) => void) | undefined;
  onFile: (file: WalkedFile) => void;
  policy: IndexingEntryPolicy;
  /** Whether the BYPASSABLE layers are collected; the agent layers always are. */
  respectGitignore: boolean;
  /**
   * Root-scope sources whose base IS the walk root, merged INTO the root
   * directory's own scope rather than pushed as a second scope at ''. See
   * {@link mergeIgnoreSources}. Scopes based ABOVE the root are pushed
   * separately, before the walk starts.
   */
  rootChain: WorkspaceIgnoreSources | undefined;
  scanLimited: boolean;
}

/**
 * Emit a regular file when (unless `includeIgnored`) the indexer ignore policy
 * keeps it. Counts every visited file against the per-root scan cap so an
 * unbounded walk can never enumerate a giant root indefinitely.
 */
function recordFile(
  ctx: WalkContext,
  name: string,
  childRelative: string,
  childAbsolute: string
): void {
  if (ctx.filesScanned >= MAX_FILES_WALKED_PER_ROOT) {
    ctx.scanLimited = true;
    return;
  }
  ctx.filesScanned += 1;
  // Asked FIRST and asked ALWAYS. The matcher is the sole authority on ignore
  // files, and it is the thing that knows `includeIgnored` drops the bypassable
  // layers while the agent layers still bind (see `createWorkspaceIgnoreMatcher`).
  // Short-circuiting on `includeIgnored` here would hand the caller a master key
  // over `.llmignore` — the one exclusion a user may treat as a security control.
  if (ctx.ignores?.ignoresFile(childRelative) === true) {
    return;
  }
  // The static policy is only a floor beneath the ignore files, so it IS
  // bypassable: a caller asking for ignored files wants the lockfiles and
  // build artifacts it excludes.
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
    ctx.onExcluded?.(childRelative, false);
    return;
  }
  ctx.onFile({ absolutePath: childAbsolute, relativePath: childRelative });
}

/**
 * Resolve a symlink entry: accept it only when its realpath target is a regular
 * file inside the canonical root. A symlink whose target escapes the root, or
 * resolves to a directory, is dropped — never traversed — so the walk can never
 * leave the workspace (mirrors the read/write/glob tools' symlink discipline).
 */
async function processSymlinkEntry(
  ctx: WalkContext,
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
  // The ignore verdict must consider the file that will be READ, not just the
  // name it is reached by. `recordFile` is handed the link's relative path with
  // the TARGET's absolute path, so without this an alias launders an excluded
  // file to every consumer downstream (glob lists it, grep reads it).
  const targetRelative = path
    .relative(ctx.canonicalRootPath, canonicalTarget)
    .split(path.sep)
    .join('/');
  if (targetRelative !== childRelative && ctx.ignores?.ignoresFile(targetRelative) === true) {
    return;
  }
  recordFile(ctx, name, childRelative, canonicalTarget);
}

async function visitDirectory(
  ctx: WalkContext,
  currentAbsolutePath: string,
  relativePosix: string
): Promise<void> {
  if (ctx.scanLimited) {
    return;
  }

  let dirEntries: import('node:fs').Dirent[];
  try {
    dirEntries = await fsPromises.readdir(currentAbsolutePath, { withFileTypes: true });
  } catch (error) {
    logger.debug('workspace walk: unreadable directory skipped', { error, path: relativePosix });
    return;
  }

  // A `.gitignore` scopes to its OWN subtree, so it is pushed on entry and
  // popped on exit. Skipped entirely under `includeIgnored`, where the caller
  // has asked to see everything and reading the files would be wasted work.
  //
  // The directory listing is ALREADY in hand, so the presence check is free —
  // and most directories have none. Reading unconditionally cost a failed open
  // per directory (~36% walk time on this repo); asking the dirents first
  // removes almost all of it.
  // Ignore files scope to their OWN subtree, so they are pushed on entry and
  // popped on exit. The directory listing is already in hand, so directories
  // declaring none cost nothing. Read even under `includeIgnored`: the agent
  // layers are a HARD boundary that flag does not bypass.
  const ownIgnoreSources = await readDirectoryIgnoreSources(
    currentAbsolutePath,
    dirEntries,
    ctx.respectGitignore,
    relativePosix
  );
  const ignoreSources =
    relativePosix === '' && ctx.rootChain !== undefined
      ? mergeIgnoreSources(ctx.rootChain, ownIgnoreSources)
      : ownIgnoreSources;
  if (ignoreSources !== undefined) {
    ctx.ignores?.push(relativePosix, ignoreSources);
  }
  try {
    await visitDirectoryEntries(ctx, currentAbsolutePath, relativePosix, dirEntries);
  } finally {
    if (ignoreSources !== undefined) {
      ctx.ignores?.pop();
    }
  }
}

/**
 * Merge the root chain UNDER a directory's own sources, per layer.
 *
 * They must land in ONE scope, not two at the same directory. Two `Ignore`
 * instances at '' would be combined by the matcher's cross-scope fold, which is
 * exactly the hand-rolled verdict-folding its module note forbids — and it
 * breaks on the same shape: with `.git/info/exclude: cache/` and
 * `.gitignore: !cache/`, the directory-only pattern matches `cache/one.md`
 * flat, the negation yields no verdict for the file form, and the file is
 * silently dropped. `git check-ignore` says otherwise, and layer 4 overrides
 * layer 2 in our own table. Concatenated in one scope, the parser resolves it.
 *
 * The chain goes FIRST within each layer so the root's own file wins, which is
 * the same shallow-to-deep ordering the parent chain already uses internally.
 */
function mergeIgnoreSources(
  chain: WorkspaceIgnoreSources,
  own: WorkspaceIgnoreSources | undefined
): WorkspaceIgnoreSources {
  if (own === undefined) {
    return chain;
  }
  const merged: WorkspaceIgnoreSources = { ...chain };
  for (const key of Object.keys(own) as (keyof WorkspaceIgnoreSources)[]) {
    const ownValue = own[key];
    if (ownValue === undefined) {
      continue;
    }
    const chainValue = merged[key];
    merged[key] = chainValue === undefined ? ownValue : `${chainValue}\n${ownValue}`;
  }
  return merged;
}

/**
 * Whether the walk descends into a subdirectory.
 *
 * PRUNING, not filtering: a directory rejected here is never listed, which is
 * the difference between skipping `.pnpm-store` and enumerating its 82k files
 * only to reject them one at a time against the per-root cap (BST-1427).
 */
function shouldTraverse(ctx: WalkContext, name: string, childRelative: string): boolean {
  // .git is never descended into even with includeIgnored (huge, opaque, never
  // useful as source).
  if (name === '.git') {
    return false;
  }
  // Asked FIRST, asked ALWAYS, and asked with the DIRECTORY form: a
  // directory-only pattern (`dist/`) does not match the bare path, and getting
  // that wrong means descending anyway. See `recordFile` for why
  // `includeIgnored` does not short-circuit the matcher.
  if (ctx.ignores?.ignoresDirectory(childRelative) === true) {
    return false;
  }
  return (
    ctx.includeIgnored ||
    ctx.policy.shouldTraverseDirectory({ directoryName: name, relativePath: childRelative })
  );
}

/**
 * Whether an exclusion may be REPORTED to the caller via `onExcluded`.
 *
 * Only exclusions `includeIgnored` could actually lift qualify. The two that do
 * not, and why silence is correct for each:
 *
 * - `.git` — never traversed regardless of the flag, so "retry with
 *   includeIgnored" is advice that cannot work.
 * - the HARD agent layers — same dead end, plus a disclosure: reporting the
 *   path tells the caller SOMETHING exists where the user asked for nothing to
 *   be visible, which is most of what `.llmignore` was bought for. A boundary
 *   that hides contents while announcing their location is not one.
 *
 * The file gate is silent for the same reason — see `recordFile`, where a hard
 * verdict returns before any report.
 */
function reportableExclusion(
  ctx: WalkContext,
  name: string,
  childRelative: string,
  asDirectory: boolean
): boolean {
  if (name === '.git') {
    return false;
  }
  return ctx.ignores?.ignoresHard(childRelative, asDirectory) !== true;
}

async function visitDirectoryEntries(
  ctx: WalkContext,
  currentAbsolutePath: string,
  relativePosix: string,
  dirEntries: readonly import('node:fs').Dirent[]
): Promise<void> {
  for (const dirent of dirEntries) {
    if (ctx.scanLimited) {
      return;
    }
    const childRelative =
      relativePosix.length === 0 ? dirent.name : `${relativePosix}/${dirent.name}`;
    const childAbsolute = path.join(currentAbsolutePath, dirent.name);

    if (dirent.isDirectory()) {
      if (shouldTraverse(ctx, dirent.name, childRelative)) {
        await visitDirectory(ctx, childAbsolute, childRelative);
      } else if (reportableExclusion(ctx, dirent.name, childRelative, true)) {
        // Reported INSTEAD of its contents: the walk stops here by design, so
        // this path is the only evidence a caller gets that the subtree exists.
        ctx.onExcluded?.(childRelative, true);
      }
      continue;
    }

    if (dirent.isSymbolicLink()) {
      await processSymlinkEntry(ctx, dirent.name, childAbsolute, childRelative);
      continue;
    }

    if (dirent.isFile()) {
      recordFile(ctx, dirent.name, childRelative, childAbsolute);
    }
  }
}

/**
 * Walk one workspace root, invoking `onFile` for each regular file whose
 * workspace-relative path survives the canonical workspace-indexer ignore policy
 * (`createBackgroundIndexingEntryPolicy`, 'balanced') — so it skips exactly what
 * the indexer (and glob) skips (.git, node_modules, dist/build output, lockfiles,
 * generated/minified artifacts) unless `includeIgnored` is set.
 *
 * Symlink discipline mirrors the read/write/glob tools: symlinked directories
 * are never traversed (so the walk can never escape the root), and every emitted
 * regular file is realpath-containment-checked before it is surfaced. The walk
 * is bounded at {@link MAX_FILES_WALKED_PER_ROOT}, reporting `scanLimited` when
 * the cap is hit (never silent).
 *
 * A root that no longer exists on disk yields zero files (logged, not thrown) so
 * a multi-root walk keeps going.
 */
export async function walkWorkspaceRoot(options: WalkRootOptions): Promise<WalkRootResult> {
  let canonicalRootPath: string;
  try {
    canonicalRootPath = await fsPromises.realpath(options.root.path);
  } catch (error) {
    logger.warn('workspace walk: root is not accessible', {
      error,
      rootId: options.root.rootId,
    });
    return { filesScanned: 0, scanLimited: false };
  }

  const ctx: WalkContext = {
    canonicalRootPath,
    filesScanned: 0,
    // When enabled, the gitignore matcher is the PRIMARY skip signal
    // (BST-1427) and the static policy below is the floor beneath it — covering
    // roots that are not git repos, and `.git` itself. Built per walk so
    // nothing leaks between roots; absent when the caller opted out, in which
    // case the floor carries the walk alone.
    // ALWAYS constructed. The agent layers are unconditional by design, so
    // gating the matcher on `respectGitignore` — a flag named and documented
    // entirely for `.gitignore` — was a master key over `.llmignore` one level
    // up from the `includeIgnored` one `recordFile` refuses to hand out. What
    // the flag controls is which BYPASSABLE layers get COLLECTED; see
    // `readDirectoryIgnoreSources`.
    ignores: createWorkspaceIgnoreMatcher({
      includeIgnored: options.includeIgnored === true,
    }),
    includeIgnored: options.includeIgnored === true,
    onExcluded: options.onExcluded,
    onFile: options.onFile,
    policy: createBackgroundIndexingEntryPolicy({ preset: 'balanced' }),
    respectGitignore: options.respectGitignore === true,
    rootChain: undefined,
    scanLimited: false,
  };
  // ALWAYS read, whatever `respectGitignore` says: the agent layers inherit
  // from parent directories, and a repo-root `.llmignore` is the normal way a
  // team ships one. `readRootIgnoreChain` itself gates the git-config
  // subprocesses, so a walk that opted out still pays only stats (BST-1435).
  const chain = await readRootIgnoreChain(canonicalRootPath, options.respectGitignore === true);
  // Outermost first, so a deeper parent overrides a shallower one. The shared
  // matcher resolves the resulting path component by component (BST-1434).
  for (const scope of chain.prefixed) {
    ctx.ignores?.push('', scope.sources, { pathPrefix: scope.pathPrefix });
  }
  // Same-base sources wait for the root directory's own scope so the two
  // compile into ONE matcher instead of being folded by hand.
  ctx.rootChain = chain.merged;
  await visitDirectory(ctx, canonicalRootPath, '');
  return { filesScanned: ctx.filesScanned, scanLimited: ctx.scanLimited };
}
