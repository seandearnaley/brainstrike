# Claude review — evidence

Supports `docs/agents/ci-quality.md` § "Claude review coverage and
orchestration" (BST-1412, BST-1640, BST-1666, BST-1743). Read this before
proposing to change the trigger, the trust boundary, prompt/diff delivery, or
the tool lockdown. The contract holds the rules; this file is the record of why.

Claude Auto Review runs on `pull_request` (`opened`, `ready_for_review`,
`reopened`; never `synchronize`) and on targeted `workflow_dispatch`. The
`pull_request` trigger is deliberate and settled (2026-09-05):

- It executes the workflow at the PR's own merge ref for **any base branch**,
  so each layer of a stack is reviewed against its parent — `gh pr diff` is
  already per-layer. `pull_request_target` cannot do this: for a stacked layer
  it would execute the *intermediate branch's* workflow copy with base-repo
  credentials, and Anthropic's App token exchange rejects its OIDC token
  regardless (anthropics/claude-code-action#713; it blacked out 7/7 automatic
  reviews on 2026-09-05 and every stacked layer). Do not switch back.
- Drafts are reviewed at `ready_for_review`; the job condition skips
  `opened`/`reopened` while `draft == true`. This matches Codex, which also
  ignores drafts, and removes the draft-open-then-ready double review. A PR
  opened ready, converted to draft, and marked ready again is reviewed twice;
  that round trip is rare and not worth guarding.
- There is no App-token exchange to depend on, because there is no action: the
  job installs the pinned Claude Code CLI and runs it directly. That removes
  the OIDC allowlist question (claude-code-action#713) structurally rather than
  routing around it with `github_token`. `secrets.CLAUDE_CODE_OAUTH_TOKEN` is
  the only secret in scope and reaches the CLI as its own credential; the job
  carries no `id-token` grant; the trusted reporter publishes with
  `github.token`. Losing the action also loses its write-permission check, so
  preparation's same-repository head guard is now load-bearing rather than
  belt-and-braces.

**Trust model, stated honestly.** Under `pull_request`, this workflow file and
`scripts/claude-review.mjs` execute from the PR's merge commit — PR-author
code — with `secrets.CLAUDE_CODE_OAUTH_TOKEN` injected and a `pull-requests:
write` token in scope. That is the exposure: a same-repository PR can rewrite
these steps to do anything with that secret and token, and since PRs here are
agent-authored, a prompt-injected agent reaches a credential by this path.
`pull_request_target` prevented it structurally and was given up for stack
coverage. "The model has no tools" and "the reporter emits text" constrain
only the model and the reporter, not PR-authored YAML. Accepted because every
PR is the owner's or their agents', and the owner reads workflow diffs; there
is no CODEOWNERS enforcement and none would be satisfiable in a one-human repo.
Mitigations available if the exposure is judged too large: rotate
`CLAUDE_CODE_OAUTH_TOKEN` on a cadence, or move the action step behind a
protected `environment:` (a GitHub setting, not repository code). The
`workflow_dispatch` path (`--ref main`) remains the trusted way to review a PR
that touches the reviewer itself.

Preparation pins the checkout to `GITHUB_SHA` and requires the event's ref
(`refs/heads/<default>` for dispatch, `refs/pull/<N>/merge` for
`pull_request`); for `pull_request` the expected ref derives from the same
payload as `GITHUB_REF`, so the checkout equality is the load-bearing check.
Any branch of this repository is an acceptable base — stacked layers pass; the
base-repository comparison is a malformed-response tripwire, since GitHub
cannot return a base outside the host repository. Automatic runs require a
same-repository head. A fork-head `pull_request` run holds a read-only token
regardless of the `permissions:` block, so its skipped disposition lands in the
job summary and the job goes red, but the PR comment cannot post; the dispatch
command in that summary still works from `main`. The repository takes no fork
PRs, so this is accepted rather than engineered around.

**Both reviewers, one budget.** Claude: one automatic review per lifecycle
event above, plus one targeted dispatch after the fix batch. Codex: one
automatic review at open/ready, plus at most one `@codex review` after the
batch. Review energy is front-loaded; later rounds trend nitpicky. Restacking
(force-push after rebase) triggers neither reviewer; a base merge that
retargets a child to `main` fires `edited`, which triggers nothing — correct,
there is nothing new to review.

**Size ceiling.** There is no environment ceiling, because nothing about the
prompt enters the environment. The review does not use
`anthropics/claude-code-action`: its only prompt input is `prompt`, which
`action.yml` carries into the runner through environment variables — `PROMPT`,
and again JSON-escaped inside `ALL_INPUTS` — where Linux caps a single variable
at 128 KiB (`MAX_ARG_STRLEN`). Above it the step died at spawn with `Argument
list too long` and no disposition (observed at 131 KiB and 188 KiB; 84 KiB
passed). There is no file input either: `run.ts` writes the prompt to
`$RUNNER_TEMP/claude-prompts/`, and `create-prompt` `rm -rf`s that directory
first, so pre-populating it is defeated by design; `execution_file` is an
output. That cap once bounded the review at a 100 KiB prompt budget, which a
dependency PR reached on lockfile churn alone — #3029 was refused at 410 KiB
with 9 KiB of non-lockfile content.

Preparation writes the whole prompt, diff included, to
`$RUNNER_TEMP/claude-review-capture/prompt.txt`, and `runReview` opens that file
and hands the descriptor to the CLI as stdin. A pipe has no size limit, so the
prompt is never measured against an argument or environment bound, and
`PROMPT_BYTE_BUDGET` is gone rather than raised. Do not reintroduce the action
to "simplify" this; it would silently restore the ceiling. The contract test
asserts the absence of `uses: …claude-code-action`, of any `prompt:` input, and
of any `structured_output` round trip, and a unit test asserts the CLI's stdin
is a file descriptor whose content is the prompt while no argument carries diff
text.

**The diff is delimited, not encoded.** It is embedded raw between a
`BEGIN`/`END` pair carrying a `CAPTURED-DIFF-<uuid>` marker generated for that
run, and the reviewer is told the text is unescaped and that a run of
backslashes is exactly what the source file contains.

It was previously embedded as `JSON.stringify(diff)` under a `CAPTURED DIFF
(JSON STRING):` header. That was load-bearing when the prompt travelled through
`GITHUB_OUTPUT`, whose heredoc framing is line-sensitive: collapsing the diff to
a single escaped line made a delimiter collision impossible. Delivering the
prompt on stdin removed that transport — the only values reaching
`GITHUB_OUTPUT` now are the literals `true` and `false` — and the encoding then
only cost fidelity. JSON doubles every backslash, so escape-dense source reaches
the reviewer as runs it must halve exactly once by inspection. On #3054 a review
halved them twice and reported a confident, detailed, entirely wrong finding:
that a regex had lost two escapes, making `[^:'(\s]` exclude the letter `s`.
The source was correct and the reasoning was sound about the text it was shown;
the transport had mangled it. Cost is not the argument — the encoding adds only
about 2% to an ordinary diff. Fidelity is. This is the same class as
`PROMPT_BYTE_BUDGET`: a mechanism kept past the constraint that justified it.

The boundary stays unforgeable because the diff is untrusted. Diff content
cannot predict the run's UUID, and `prepareReview` enforces that rather than
assuming it: a diff containing the generated marker is refused with an
**incomplete** disposition instead of being framed ambiguously. The UUID is
injectable so the refusal is exercised by a test rather than argued from
probability. A forged `END CAPTURED-DIFF-…` line inside a diff is content, and
a test asserts the real marker still appears exactly twice and closes the
prompt. Do not restore JSON encoding, and do not replace the fence with a fixed
string: a constant marker is forgeable by any diff that contains it. Tests in
`scripts/__tests__/claude-review.test.mjs` pin byte-for-byte delivery of
backslash-dense content, the forgery attempt, the delimiter-collision refusal,
and a diff with no trailing newline; every one was mutation-verified.

**Generated files are summarized, and it is said out loud.** Before anything is
measured, `scripts/lockfile-diff-summary.mjs` replaces `pnpm-lock.yaml` hunks in
the captured diff with a derived summary: packages added, removed, and
version-changed; packages left on more than one version among the entries the
diff adds; and any introduced `resolution:` that is not an `{integrity: ...}`
hash, which would mean a tarball, git, or directory source and is currently zero
in this tree. Measured on #3029, 401 KiB of lockfile becomes 13 KiB, and the
whole diff 410 KiB becomes 22 KiB. The summary carries more signal than the
hunks it replaces: it named 22 packages sitting on multiple resolved versions,
which is the `@codemirror/state` duplicate-resolution class that survived two
rebases in #3036 and needed a hand-written guard test.

**A repointed edge is reported, because the entry lists structurally cannot show
one.** A dedupe or a security lift leaves both versions already present and only
moves a parent's `dependencies:` at one of them, so neither end is an added or
removed entry. #3053 lifted `@ai-sdk/openai > @ai-sdk/provider-utils > undici`
from 7.28.0 to an already-present 7.29.1, and the entry lists could report only
`undici: 7.28.0 -> 6.28.1, 8.10.2` — unrelated additions that read as the
subtree leaving the 7.x line altogether. The reviewer flagged the apparent
contradiction of the PR's stated remediation and had to ask for `pnpm why
undici` to be pasted in, because the summary could not answer it. A
`dependency edges repointed:` section now does: on that PR it reports
`undici: 7.28.0 => 7.29.1 (4 edges)` and settles the question.

Resolved edges sit at six spaces inside `snapshots:`, and the **section** scopes
them rather than the enclosing `dependencies:` key. Under `-U3` a block key four
lines above a changed edge falls outside the hunk — #3053's flagship hunk
carried neither its key nor its `dependencies:` line — while the section
survives, because git's funcname trailer names the nearest column-0 line and a
lockfile's are exactly its section markers. Section scoping is sufficient, since
inside `snapshots:` every six-space `name: value` line is a resolved edge and
`transitivePeerDependencies` emits only `- item` entries; it is also necessary,
since `packages:` `peerDependencies:` sit at the same depth but hold ranges, not
resolutions. A parent is named only where the diff shows its block key and is
never carried across a hunk boundary, because a parent from the previous hunk is
worse than none: it is confidently wrong. Pairing is by dependency name, never
by position. Parents are split with `splitPackageKey`, so a peer suffix never
steals the version. Edges are grouped by the transition they make rather than
listed one per line, which is both the reviewer's actual question and the
tighter bound: a dedupe repointing hundreds of edges still costs a handful of
lines, because the section is bounded by distinct transitions rather than by
edge count. Both axes are capped anyway (`TRANSITIONS_LISTED`, `PARENTS_LISTED`)
since a wide update widens the transition list too, and the cut is by sort
order, so re-reading a re-pushed PR yields the same list rather than an
accident of hunk order — compared by code unit rather than `localeCompare`,
whose collation follows the runtime's ICU data.

Two things this deliberately does not report, both consequences of flushing at
every hunk boundary. A removal and an addition of the same dependency that land
in *different* hunks are never paired, so a line that both moved far and changed
version is missed; pairing across that gap would cost the attribution guarantee,
which is the worse trade. And a hunk whose header names no section cannot be
classified at all — that shape is not expected, since `gh pr diff` derives the
trailer from the nearest column-0 line and this file's line 1 is
`lockfileVersion:` — but if it occurs, the changed dependency lines are counted
and stated rather than dropped behind a confident total. With no repointed edges
the section costs two lines — the count and its blank separator — because it is
emitted on every summary and a
summary only replaces hunks it shrinks: standing prose here would narrow what
gets summarized at all. Every one of those guards is mutation-verified: each was
confirmed to fail against a deliberate regression before being trusted.

Every other file passes through byte for byte, and a header the splitter cannot
parse falls through as "not summarized" rather than being summarized against the
wrong path. Matching is on basename, so `docs/pnpm-lock.yaml.md` is untouched. A
lockfile change smaller than its own summary keeps its exact hunks. Importer
`specifier:` changes are not lost, because they mirror each `package.json`,
whose diffs are complete.

This is the one place the review is shown something other than `gh pr diff`, so
it is never silent: preparation states the substitution and its byte counts in
the prompt and tells the model not to claim line-level coverage of the replaced
hunks, and the trusted reporter repeats it in the published disposition so a
human reading the review knows what the reviewer was given. The prompt names at
most `SUBSTITUTIONS_LISTED` files and aggregates the rest: the prompt has no
size limit any more, but a per-file list would still spend context on paths
rather than on the summaries. Nothing else is ever substituted, and no partial
review is published in place of a refused one.

What bounds the diff now is the model's context window alone, at a
`DIFF_BYTE_CEILING` of 512 KiB. Unlike `MAX_ARG_STRLEN` this is a chosen margin
rather than a measured cliff: roughly 145k tokens at the ~3.5 bytes/token that
diff text runs, leaving a 200k window room for the system prompt and the
structured output. Over it, preparation refuses with an **incomplete**
disposition stating both numbers. No narrower diff is ever substituted and no
partial review is published; a PR that size needs splitting, not a shorter
review.

The result comes back the same way. `runReview` records the CLI's structured
output to `$RUNNER_TEMP/claude-review-result.json` and the reporter reads it
from disk; only the step's own `outcome` travels as an environment variable.
Carrying the review text back through one would reintroduce the same class of
limit in the other direction.

On a nonzero CLI exit, remember that `--output-format json` can put the useful
failure payload on **stdout** while stderr is empty. `runReview` parses that
payload and carries only a fixed, bounded set of diagnostic fields into the
incomplete disposition: `subtype`, `is_error`, `api_error_status`,
`terminal_reason`, `error`, string entries from `errors`, and `result` only
when `is_error` is true. It never dumps the complete JSON object. Each field
is capped at 500 characters and the assembled reason at 4 KiB. The same reason
is written to stderr with the stable prefix
`CLAUDE_REVIEW_CLI_FAILED:` so the failed run step is useful without opening
the later reporter step. Raw JSON diagnostics over 64 KiB are not parsed and
produce a fixed overflow marker. Other stdout and stderr diagnostics are capped
before control-character normalization as well as before either destination.

**The published body reaches `gh` on stdin too (BST-1743).** The reporter
posts with `gh pr comment --body-file -` and hands the body to `execFileSync`
as `input`, never as a `--body` argument. Node refuses any argv element that
contains a NUL byte (`ERR_INVALID_ARG_VALUE: The argument 'args[6]' must be a
string without null bytes`), and a reviewer that faithfully quotes the diff
will produce one: twice on #3119 the review had completed and validated at the
exact head, then destroyed itself by reproducing the PR's own `\u0000` latch
separator in its prose. Any control character in reviewed code can do this,
and reviewing such code is normal. A pipe carries every byte sequence, so the
reviewer's text is published exactly as written — do not "fix" this by
stripping or escaping, which would alter the review, and do not move the body
back to argv. It is the same lesson as the prompt's 128 KiB `MAX_ARG_STRLEN`
ceiling (BST-1666) at a different limit; `gh` 2.91.0 documents `-F,
--body-file file … (use "-" to read from standard input)`. The unit test's
`gh` mock mirrors Node's argv contract and refuses NUL, so reverting to
`--body` fails the suite with the production error text. When publication
does fail, the reporter writes the cause to **stderr** with the stable prefix
`CLAUDE_REVIEW_PUBLICATION_FAILED:` as well as to the step summary — grep the
job log for that prefix; before this the log showed only a bare exit code and
the reason lived in the summary alone. The exit code is unchanged: nothing
published is still **incomplete** and red.

Automatic review retains the `opened`, `ready_for_review`, and `reopened`
lifecycle and omits `synchronize`. Changes to the workflow or its orchestration
script receive an explicit **skipped** disposition; a maintainer can request
coverage with the trusted default-branch workflow:

```bash
gh workflow run claude-code-review.yml --repo seandearnaley/brainstrike --ref main \
  -f pr_number=123 -f expected_head=<40-character-current-head> \
  -f 'focus=Verify the specific workflow trust boundary or previously reported findings'
```

This is a targeted review, not another automatic whole-PR round. Follow the
initial review plus one batched re-review budget above; a third whole-PR round
needs user approval. Never close/reopen a PR, toggle its draft status, push an
empty commit, or restart the full Test pipeline merely to request Claude review.
A newly introduced workflow cannot be dispatched from the default branch until
an approved merge makes it available there. A PR that changes this workflow or
its script is self-change-skipped, so its own automatic review never runs; use
the trusted dispatch above for coverage and obtain human review. Local contract
fixtures are not proof that a live Claude review completed.

`scripts/claude-review.mjs` captures `gh pr diff`, checking the live head and
base before and after capture, then writes that snapshot to a file under
`$RUNNER_TEMP` and streams it to the CLI on stdin. Orchestration keeps the
fetch, which is what makes the exact-head guarantee possible: a model running
`gh pr diff` itself — the vendor's documented review pattern — would leave
nothing able to attest what was reviewed, and the pinned `head_sha` would
become a claim the model echoes rather than a fact. Only the delivery mechanism
departs from the reference architecture; the trust boundary is unchanged.

Claude has no file, shell, network, or GitHub tools: `--tools=` empties the
built-in set and ignores user, project, and local settings, so it is the hard
cap and no permission rule can widen it; `--disallowedTools "mcp__*"` denies MCP
tools, strict empty MCP configuration prevents other servers loading, and slash
commands are disabled. Only the schema's `StructuredOutput` tool remains. Do not
replace this with `allowedTools` plus `dontAsk`: that restores the whole
built-in set and read-only commands remain available under that permission mode.
The model and 80-turn ceiling remain unchanged.

An earlier revision of this change granted `Read` so the model could open a
diff file, because the prompt could not carry one. Delivering the prompt on
stdin removed the reason, and the grant with it: there is no `--add-dir`, no
capture file for the model to open, and no widening of what it can reach. Prefer
this ordering generally — when a limit forces a capability grant, check whether
the limit is real before accepting the grant.

`scripts/probe-claude-review-tools.mjs` verifies the boundary behaviorally
against the exact CLI version the workflow installs, delivering its prompt on
stdin the way production does: `Bash` rejected as an unavailable tool, a private
file left unread, only `StructuredOutput` exposed. A contract test pins the
probe's asserted version to the workflow's install pin, so the probe cannot
certify a build CI never runs. Update the probe with any change to the tool
arguments.

Claude returns completed/head/base/scope fields and review text. Trusted
orchestration validates the exact request, rechecks live head/base, and posts
that text with an explicit **Claude-generated review** attribution. Both
invocation paths use top-level file/line findings; the model cannot post inline
comments or execute untrusted diff content. Missing, partial, malformed,
wrong-head/base/scope, oversized, or unpublishable output stays incomplete.
Reviews are never truncated to fit GitHub's comment-body limit. A diff that
exceeds the runner/action's input limit also fails visibly; no narrower diff is
substituted.

The final handler records a disposition in the workflow summary and publishes
it on the PR, tied to the requested head, scope, and run attempt. Publication
failures remain incomplete in the summary and fail the job:

- **Skipped:** the automatic self-change or untrusted-head guard withheld
  Claude execution; the disposition carries the dispatch command whose focus
  matches what was withheld.
- **Incomplete:** preparation/action failure, an oversized diff, the 80-turn
  cap, cancellation, missing exact-run structured review output, publication
  failure, or a changed/closed PR invalidates coverage. The reporter's message
  still names an upstream OIDC skip; that is residual defense only — no OIDC
  path exists now that the job runs the CLI directly instead of the action.
- **Completed:** the action explicitly concluded successfully, the
  complete structured output matches the requested head/base/scope, live
  head/base checks still match, and the trusted reporter publishes the actual
  review text. It is coverage, not approval; inspect and close its findings.

Skipped and incomplete dispositions fail the review job. `continue-on-error`
only allows this final reporting step to run; it preserves BST-1412's red
failure disposition. Hard runner loss or checkout failure can prevent final
reporting; a missing disposition never counts as completion. The required Test
checks remain separate. Any later push invalidates an older head's coverage.
Contracts execute normal, failure, self-change, targeted, moving-head, missing
content, and trust rejection paths in `scripts/__tests__/claude-review.test.mjs`
and pin the workflow wiring in `claude-auto-review-contract.test.mjs`.
The opt-in CLI boundary check uses a fake localhost Anthropic API and no real
credentials:

```bash
node scripts/probe-claude-review-tools.mjs /absolute/path/to/claude
```

Use CLI 2.1.280, the version the workflow installs with `npm install --global`. The fixture injects
an unsolicited Bash file-read tool call: it must be rejected, the private
fixture content must remain unread, and structured output must still succeed.
This validates model tool isolation, not live OIDC or semantic review quality.

**Model id and CLI catalog (#3279).** The model id lives once in
`claudeReviewModel` (`scripts/claude-review.mjs`); `claude.yml` repeats it under
a contract test, and `runReview pins the review model` pins the literal. A CLI
whose model catalog lacks the id does not fail: it assumes a 200k context window
and auto-compacts. CLI 2.1.261 lacked `claude-opus-5-5`; 2.1.280 lists it
(checked with `grep -ac claude-opus-5-5` on the platform binary). The probe
stubs the API, so it cannot catch this. `@claude` runs the CLI bundled with
`claude-code-action@v1` (2.1.278 at the time, also lacking the id) and so runs
capped until the action updates; that lag was accepted.

Primary trust evidence: [Anthropic action security guidance](https://github.com/anthropics/claude-code-action/blob/d75b94d5ad426cb8546e6628b6f5f19b84e5cce1/docs/security.md),
[manual dispatch example](https://github.com/anthropics/claude-code-action/blob/d75b94d5ad426cb8546e6628b6f5f19b84e5cce1/examples/manual-code-analysis.yml),
[OIDC skip and conclusion implementation](https://github.com/anthropics/claude-code-action/blob/d75b94d5ad426cb8546e6628b6f5f19b84e5cce1/src/entrypoints/run.ts),
[Claude CLI tool controls](https://code.claude.com/docs/en/cli-reference),
and [GitHub's trusted-event security guidance](https://docs.github.com/en/actions/reference/security/secure-use).
