# The fence's always-deny list, refusals, and env allow-list — evidence

Supports `docs/agents/code-execution.md` § "FenceExecutor". Read this before
loosening a `FencePolicyError` refusal, globbing the always-deny list, or
adding a variable to `INHERITED_ENV_VARS`. The contract holds the rules; this
file is the record of why, including the macOS root-`allowRead` measurement.

Two refusals landed after this text was written and are not described below
(verified in `packages/agent/src/fence/fence-policy.ts`): an `allowRead` entry
that names EXACTLY a path the same policy also denies is refused, because srt
resolves that contradiction in the allow's favour and drops the deny silently;
and an `allowWrite` at or under an always-denied credential store is refused,
because bubblewrap re-binds an allowed write path read-WRITE over its tmpfs
mask and there is no write bind you cannot read. Both are in the contract.

- **Always-deny-read** (`ALWAYS_DENY_READ_PATHS`, applied on top of every
  policy): `.ssh`, `.aws`, `.gnupg`, `.config/gcloud`, `.config/gh`, `.kube`,
  `.docker`, `.netrc`, `.npmrc`, `.pypirc` — resolved to ABSOLUTE paths from
  `os.homedir()` here, not handed to srt as `~/...`: a path this sensitive
  must not depend on another package's tilde expansion. They stay literal
  (never globbed) because a literal path is what the containment checks compare
  against, and because the literal re-application on top of a broader
  `allowRead` is the srt behavior this layer verifies by execution. srt's
  GLOB-deny handling is version-dependent and is NOT relied on (0.0.72 changed
  macOS to re-emit glob denies where a broader allow used to clobber them; on
  Linux a glob deny is expanded by ripgrep at run time). An `allowRead` entry
  AT or UNDER one of these throws
  `FencePolicyError`; it is never silently dropped. An ANCESTOR entry is fine
  (srt re-emits the nested deny).
- **Every policy path is shape-checked, then RESOLVED, and anything ambiguous
  is refused.** A GLOB in `allowRead` is rejected — srt would expand it into
  paths the containment guard never compared, so `allowRead: ['~/.config/*']`
  would silently re-open `~/.config/gcloud`. A RELATIVE path is rejected (srt
  resolves it against the Node process cwd, not `scratchDir`), as is a `..`
  segment and a `~` (never expanded — see the seam's rule).
- **A ROOT-WIDE `allowRead` is refused** (`FencePolicyError`), even though it is
  a mere ancestor of the always-denied stores. Ancestors are normally safe
  because srt re-emits the nested deny after the broader allow — but through
  0.0.75 that re-emission tests `denied.startsWith(allowed + '/')`, which for
  `allowed === '/'` compares against `'//'` and never matches. **Measured on
  macOS (BST-1071): `allowRead: ['/']` made `~/.ssh/*` and the contents of
  `~/.config/gh/hosts.yml` readable from sandboxed code.** Re-measured against
  0.0.73's generated Seatbelt profile in BST-1285 and UNCHANGED, and again at
  0.0.75 in BST-1669, where the re-emission line is byte-identical to 0.0.73's
  even though 0.0.75 rewrote macOS deny emission to fold literal denies into
  regexes — the root allow is still emitted after the credential deny under
  last-match-wins — so this refusal remains load-bearing, not redundant. Linux
  is unaffected (bubblewrap masks denied directories with tmpfs) — re-measured
  by execution under real bwrap at 0.0.73 in BST-1285 — so the Linux half CI now
  runs would not have caught this one on its own. That is why the refusal lives
  in the policy layer, not a platform branch. Every ancestor SHORT of the root
  is still accepted.
- **Containment compares `realpath` output** — the reference implementation of
  the seam's "resolve before asking" requirement above, including the
  nonexistent-path error and the best-effort deny canonicalization. The
  resolver is injected (`FencePathResolver`, defaulting to
  `fs.promises.realpath`) so the mapping stays in the cacheable unit lane;
  the real-filesystem behaviour is proven in the integration lane.
- **The sandboxed process environment is an ALLOW-LIST, never a pass-through**
  (`INHERITED_ENV_VARS`: `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `PATH`,
  `TMPDIR`, `TZ`). Denying `~/.aws` on disk is pointless if
  `AWS_SECRET_ACCESS_KEY` — or this app's provider API keys — ride in on the
  environment, and that channel is not covered by any filesystem rule.
  Anything an interpreter needs beyond the list is named explicitly on
  `FenceInterpreter.env`. Keys srt CHANGED in the env it returns are carried
  over, so a future srt that starts returning proxy vars in `env` keeps
  working without reopening the host environment. Proven by an integration
  test that plants secret-shaped vars in the parent and asserts their absence.
- **`scratchDir` is always writable** and listed first in
  `filesystem.allowWrite`; the script srt runs is written there with
  `mode: 0o600` (this module does not own `scratchDir`, and a shared one would
  otherwise leave a window where another local user could read or replace the
  script) and removed after the run.
