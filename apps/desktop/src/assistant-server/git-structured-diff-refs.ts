/**
 * Ref resolution + validation for the `commit`/`range` `structuredFileDiff`
 * modes (BST-1113) — split out of `git-structured-diff.ts` to keep that
 * file under its line-count ratchet (see its module doc comment).
 *
 * Two concerns live here:
 *
 * 1. RENDERER-SUPPLIED REF SAFETY: `commitId` and `baseRef` come from the
 *    renderer/model and are interpolated into git ref arguments (the
 *    `<ref>:./<path>` magic-pathspec `cat-file` specs, and `git diff <old>
 *    <new>` args). `execFile`'s no-shell invocation rules out shell
 *    injection, but NOT argument-as-option injection — a value starting
 *    with `-` is still read as a git OPTION, not a ref, by every one of
 *    those commands. Validation rule (stated once, applied to both
 *    fields): non-empty; no leading `-` (never let a ref be read as an
 *    option); no whitespace (a ref/commit id never legitimately contains
 *    any); and no `:` (the `<ref>:./<path>` spec we build ourselves uses
 *    the FIRST `:` as its own separator — a ref containing one would
 *    corrupt that spec, silently pointing at the wrong object). `commitId`
 *    is additionally constrained to a full git object id
 *    (`[0-9a-f]{40,64}`) because the engine always receives it
 *    pre-resolved to a SHA; `baseRef` stays a general (but
 *    still injection-safe) ref string because ITS caller-resolved value
 *    may legitimately be a branch name (`origin/main`), a tag, a SHA, or
 *    the empty-tree sentinel below — the engine never resolves a symbolic
 *    ref itself (see `StructuredFileDiffParams`'s `range` arm doc comment
 *    in `packages/types/src/changeset.ts`).
 *
 * 2. ROOT-COMMIT FALLBACK: `commit` mode's old side is normally
 *    `<commitId>^`, which does not exist for a root commit (no parent).
 *    Detection uses `git rev-list --parents -n 1 <commit>` (a root commit's
 *    output has no second token). The old side must be an actual REF
 *    STRING: every side of a `structuredFileDiff` is read INDIVIDUALLY via
 *    `readRefBlob`'s `<ref>:./<path>` spec, not assembled from one combined
 *    diff invocation. So a root commit's "old ref"
 *    resolves to git's well-known empty-tree object id instead.
 *    `readRefBlob` against that id then naturally reports every path as
 *    "absent" (the empty tree object has zero entries), which flows
 *    through the EXACT SAME absent/added machinery every other mode
 *    already uses — no special-casing needed downstream in
 *    `git-structured-diff.ts`.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { gitCommandFailed, gitInvalid, gitUnexpected } from './git-failure';
import { type GitCommandRun, stripLineEnding } from './git-service';

/**
 * git's well-known empty-tree object id (`git hash-object -t tree
 * /dev/null`) — SHA-1 and SHA-256 give DIFFERENT hashes for the identical
 * (repo-independent) empty tree object, because the object id is a hash of
 * the object's on-disk encoding, which itself names the hash algorithm.
 * `--object-format=sha256` repos have been supported since git 2.29
 * (`git init --object-format=sha256`); `validateCommitId`'s
 * `/^[0-9a-f]{40,64}$/` a few lines down already spans both lengths, so this
 * module has always expected SHA-256 object ids to flow through it — only
 * this constant was hardcoded SHA-1-only (review finding). See
 * {@link resolveEmptyTreeHash}, which picks the right one PER REPO rather
 * than assuming SHA-1.
 */
const EMPTY_TREE_HASH_BY_FORMAT: Readonly<Record<string, string>> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

/**
 * Structural type for the git-command runner this module closes over —
 * matches `createStructuredDiffOps`'s `InvokeFn` in `git-structured-diff.ts`
 * exactly (the plain, non-hook-free `invoke`: ref resolution is a read-only
 * plumbing command, never a mutation).
 */
type InvokeFn = (
  args: readonly string[],
  timeoutMs?: number,
  binaryStdout?: boolean
) => Promise<GitCommandRun>;

/**
 * Shared ref-argument safety check — see this module's doc comment, part 1.
 * Applied to both `commitId` (further constrained by
 * {@link validateCommitId}) and `baseRef` (via {@link validateBaseRef}).
 */
function validateRefArg(value: unknown, fieldName: string): BoundaryResult<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return gitInvalid(`${fieldName} must be a non-empty string`);
  }
  if (/\s/u.test(value)) {
    return gitInvalid(`${fieldName} must not contain whitespace`);
  }
  if (value.includes(':')) {
    return gitInvalid(
      `${fieldName} must not contain ":" (would corrupt the "<ref>:./<path>" spec form)`
    );
  }
  if (value.startsWith('-')) {
    return gitInvalid(
      `${fieldName} must not start with "-" (would be read as a git option, not a ref)`
    );
  }
  return { ok: true, value };
}

/**
 * Validate a renderer-supplied `commitId` (mode `commit`): the shared ref
 * safety rule plus the exact full-object-id shape.
 */
export function validateCommitId(value: unknown): BoundaryResult<string> {
  const safe = validateRefArg(value, 'commitId');
  if (!safe.ok) {
    return safe;
  }
  if (!/^[0-9a-f]{40,64}$/u.test(safe.value)) {
    return gitInvalid('commitId must be a full object id returned by Git');
  }
  return safe;
}

/**
 * Validate a renderer-supplied `baseRef` (mode `range`): the shared ref
 * safety rule only — unlike `commitId`, `baseRef` may legitimately be a
 * branch name, tag, or the empty-tree id, never constrained to a hex
 * object id shape.
 */
export function validateBaseRef(value: unknown): BoundaryResult<string> {
  return validateRefArg(value, 'baseRef');
}

/**
 * Resolve THIS repository's empty-tree object id by asking git which object
 * format it uses (`git rev-parse --show-object-format`, supported since git
 * 2.29 alongside `--object-format` itself) rather than assuming SHA-1 — see
 * {@link EMPTY_TREE_HASH_BY_FORMAT}'s doc comment. An unrecognized format
 * (a future algorithm this module doesn't yet know the empty-tree id for) is
 * a visible typed error, never a silent SHA-1 guess.
 */
export async function resolveEmptyTreeHash(invoke: InvokeFn): Promise<BoundaryResult<string>> {
  const run_ = await invoke(['rev-parse', '--show-object-format']);
  if (run_.exitCode !== 0) {
    return gitCommandFailed(run_);
  }
  const format = stripLineEnding(run_.stdout).trim();
  const hash = EMPTY_TREE_HASH_BY_FORMAT[format];
  if (!hash) {
    return gitUnexpected(`unsupported git object-format "${format}" for the empty-tree id`);
  }
  return { ok: true, value: hash };
}

/**
 * Resolve `commit` mode's OLD ref for {@link resolveEmptyTreeHash}'s
 * root-commit fallback: `${commitId}^` when a first parent exists (validated
 * via the `rev-list --parents` probe below —
 * never trusted blind, since an invalid `commitId` must surface as a typed
 * error here rather than a confusing absent-side result downstream), or the
 * PER-REPO empty-tree id when `commitId` names a root commit. See this
 * module's doc comment, ROOT-COMMIT FALLBACK.
 *
 * For a MERGE commit `^` names the FIRST parent, so `commit` mode is a
 * first-parent diff. That is honest, not a defect: changes that arrived via the
 * merged branch appear as the merge's changes, while mainline changes
 * between the merge-base and the merge appear as no difference.
 */
export async function resolveCommitOldRef(
  invoke: InvokeFn,
  commitId: string
): Promise<BoundaryResult<string>> {
  const run_ = await invoke(['rev-list', '--parents', '-n', '1', commitId]);
  if (run_.exitCode !== 0) {
    return gitCommandFailed(run_);
  }
  const [resolvedCommit, firstParent] = run_.stdout.trim().split(/\s+/u);
  if (resolvedCommit !== commitId) {
    return gitUnexpected('git returned mismatched commit ancestry metadata');
  }
  if (firstParent === undefined) {
    return await resolveEmptyTreeHash(invoke);
  }
  if (!/^[0-9a-f]{40,64}$/u.test(firstParent)) {
    return gitUnexpected('git returned an invalid first-parent object id');
  }
  return { ok: true, value: `${commitId}^` };
}
