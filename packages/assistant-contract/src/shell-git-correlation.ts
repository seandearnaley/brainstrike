/**
 * Shell-command TRIGGER scan for the worktree/PR correlator (BST-1392, spec
 * §6.4). Pure, bounded, and deliberately conservative in what it CLAIMS.
 *
 * It answers one question — "is it worth asking git and the forge what actually
 * changed" — and nothing downstream trusts it for anything else. It extracts no
 * path and no PR number: `git worktree add "$DIR/$(date +%s)"` is unparseable
 * in principle, so the reconciler re-reads the real inventory instead. A false
 * positive therefore costs one bounded inventory reconcile against the
 * caller's pre-command worktree snapshot; it never blindly adopts an unmanaged
 * checkout that already existed. A false negative costs a timeline breadcrumb,
 * which the ledger's own row and the Map still show.
 *
 * The scan window mirrors `run-verdict.ts`'s discipline: bounded input, no
 * excerpt of the command ever reaches a log or a run event.
 */

/** Documented scan bound: the leading 16 KiB (UTF-16 code units) of the command. */
export const SHELL_CORRELATION_SCAN_CHARS = 16 * 1024;

export interface ShellGitCorrelationSignals {
  readonly createdPullRequest: boolean;
  readonly touchedWorktrees: boolean;
}

// `git [-C <path>|-c k=v|--<flag>]* worktree <add|remove|prune|move>`, anchored
// at a command boundary (start, `;`, `&&`, `||`, `|`, or a newline) so a
// `worktree add` inside an echoed string or an `rg` pattern never matches.
const GIT_WORKTREE_RE =
  /(?:^|[\n;|&])\s*(?:[A-Za-z_][\w]*=\S*\s+)*git(?:\s+(?:-C\s+\S+|-c\s+\S+|--\S+))*\s+worktree\s+(?:add|move|prune|remove)\b/u;

// `gh pr create` only. `gh pr view`/`list` observe, they do not create.
const GH_PR_CREATE_RE = /(?:^|[\n;|&])\s*(?:[A-Za-z_][\w]*=\S*\s+)*gh\s+pr\s+create\b/u;

export function scanShellCommandForGitSignals(command: string): ShellGitCorrelationSignals {
  const window = command.slice(0, SHELL_CORRELATION_SCAN_CHARS);
  return {
    createdPullRequest: GH_PR_CREATE_RE.test(window),
    touchedWorktrees: GIT_WORKTREE_RE.test(window),
  };
}
