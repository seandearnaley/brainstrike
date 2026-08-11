/**
 * History/commit-object read ops for the desktop `git` IPC domain — `history`
 * and `commitFiles`, split out of `git-service.ts` (BST-1111, BST-1118) to
 * keep that file under the line-count ratchet.
 *
 * Like `git-service.ts`, this module has NO Electron imports so it is
 * hermetically testable: `createHistoryOps` takes the SAME injected `invoke`
 * runner the caller (`createGitService`) builds around its `execFile`-style
 * `GitCommandRunner`, already bound to the validated workspace `cwd`. Neither
 * op mutates the repository, so unlike the rest of `git-service.ts` they
 * never need the hook-disabling `invokeHookFree` variant. There is no
 * `exec`/`spawn shell:true` anywhere in this file, and every git failure
 * resolves into a structured `{ ok: false, error }` result rather than
 * throwing across the IPC boundary.
 *
 * The caller (`createGitService`, or ultimately the IPC handler) remains
 * responsible for resolving + containment-checking `cwd` against a known
 * workspace root before any of this runs.
 */
import type { GitCommitFile, GitHistoryPage, GitResult } from '@brainstrike/types';
import { parseCommitFiles, parseHistoryPage } from './git-repository-parsers';
import { describeFailure, type GitCommandRun, toErrorMessage } from './git-service';

/**
 * Structural type for the git-command runner this module closes over —
 * matches `createGitService`'s internal `invoke` helper in `git-service.ts`
 * exactly (default `timeoutMs`, optional `binaryStdout`).
 */
type InvokeFn = (
  args: readonly string[],
  timeoutMs?: number,
  binaryStdout?: boolean
) => Promise<GitCommandRun>;

/** Validate a renderer/model-supplied commit id: full-length hex object id only. */
function requireCommitId(commit: unknown): GitResult<string> {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(commit)) {
    return { error: 'commit must be a full object id returned by Git', ok: false };
  }
  return { ok: true, value: commit };
}

export interface HistoryOpsOptions {
  readonly invoke: InvokeFn;
}

/**
 * Build the `history`/`commitFiles` ops bound to a single,
 * already-validated `cwd` and the caller's `invoke` runner. Mirrors
 * `createGitService`'s contract: every method returns a `GitResult`, a git
 * failure becomes `{ ok: false, error }`, never a throw.
 */
export function createHistoryOps({ invoke }: HistoryOpsOptions) {
  async function resolveHistoryCommit(ref: string | undefined): Promise<GitResult<string>> {
    if (ref === undefined) {
      const head = await invoke(['rev-parse', '--verify', 'HEAD^{commit}']);
      return head.exitCode === 0
        ? { ok: true, value: head.stdout.trim() }
        : { error: describeFailure(head), ok: false };
    }
    if (/^[0-9a-f]{40,64}$/.test(ref)) {
      const commit = await invoke(['rev-parse', '--verify', `${ref}^{commit}`]);
      return commit.exitCode === 0
        ? { ok: true, value: commit.stdout.trim() }
        : { error: describeFailure(commit), ok: false };
    }
    const branch = await invoke(['show-ref', '--verify', '--hash', `refs/heads/${ref}`]);
    if (branch.exitCode !== 0) {
      return { error: `local branch "${ref}" does not exist`, ok: false };
    }
    return { ok: true, value: branch.stdout.trim() };
  }

  async function resolveFirstParent(commit: string): Promise<GitResult<string | null>> {
    const run_ = await invoke(['rev-list', '--parents', '-n', '1', commit]);
    if (run_.exitCode !== 0) {
      return { error: describeFailure(run_), ok: false };
    }
    const [resolvedCommit, firstParent] = run_.stdout.trim().split(/\s+/);
    if (resolvedCommit !== commit) {
      return { error: 'git returned mismatched commit ancestry metadata', ok: false };
    }
    if (firstParent === undefined) {
      return { ok: true, value: null };
    }
    if (!/^[0-9a-f]{40,64}$/.test(firstParent)) {
      return { error: 'git returned an invalid first-parent object id', ok: false };
    }
    return { ok: true, value: firstParent };
  }

  return {
    /** File list for a historical commit, scoped to the opened workspace root. */
    commitFiles: async (params: {
      commit: string;
    }): Promise<GitResult<readonly GitCommitFile[]>> => {
      try {
        const commit = requireCommitId(params.commit);
        if (!commit.ok) {
          return commit;
        }
        const firstParent = await resolveFirstParent(commit.value);
        if (!firstParent.ok) {
          return firstParent;
        }
        const run_ = await invoke([
          'diff-tree',
          ...(firstParent.value ? [] : ['--root']),
          '--no-commit-id',
          '--name-status',
          '-r',
          '-M',
          '--relative',
          '-z',
          ...(firstParent.value ? [firstParent.value, commit.value] : [commit.value]),
          '--',
          '.',
        ]);
        if (run_.exitCode !== 0) {
          return { error: describeFailure(run_), ok: false };
        }
        return { ok: true, value: parseCommitFiles(run_.stdout) };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },

    /** Paginated, summary-only history for HEAD, a local branch, or a returned OID. */
    history: async (params: {
      limit: number;
      offset: number;
      ref?: string | undefined;
    }): Promise<GitResult<GitHistoryPage>> => {
      try {
        if (!(Number.isInteger(params.limit) && params.limit >= 1 && params.limit <= 200)) {
          return { error: 'history limit must be an integer between 1 and 200', ok: false };
        }
        if (!(Number.isInteger(params.offset) && params.offset >= 0 && params.offset <= 100_000)) {
          return { error: 'history offset must be an integer between 0 and 100000', ok: false };
        }
        const commit = await resolveHistoryCommit(params.ref);
        if (!commit.ok) {
          return commit;
        }
        const format = '%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%aI%x00%cI%x00%P%x00%D';
        const prefixRun = await invoke(['rev-parse', '--show-prefix']);
        if (prefixRun.exitCode !== 0) {
          return { error: describeFailure(prefixRun), ok: false };
        }
        const openedPrefix = prefixRun.stdout.replace(/\r?\n$/, '');
        const run_ = await invoke([
          'log',
          '-z',
          `--max-count=${params.limit + 1}`,
          `--skip=${params.offset}`,
          `--format=${format}`,
          commit.value,
          ...(openedPrefix.length > 0 ? ['--', '.'] : []),
        ]);
        if (run_.exitCode !== 0) {
          return { error: describeFailure(run_), ok: false };
        }
        return {
          ok: true,
          value: parseHistoryPage(run_.stdout, { limit: params.limit, offset: params.offset }),
        };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
  };
}
