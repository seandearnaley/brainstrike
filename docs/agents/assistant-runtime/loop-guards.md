# Loop guards — evidence

Supports `docs/agents/assistant-runtime.md` § "LOOP GUARDS".
Read before changing the repeated-call, unchanged-read or edit-failure mechanisms, their scope authority, or their bounds. BST-1188, BST-1192, BST-1197, PRs #2323 and #2332.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2769-2911), extracted verbatim.

The desktop assistant server applies three thread-scoped, main-process-memory
guards to stop an agent from repeatedly reconfirming evidence it already has.
This is a desktop native-tool capability boundary: web does not construct these
tools, and no network round trip or persistent store participates. Design
settled across PR #2323 review (both an automated and an LLM reviewer found
real correctness bugs in the first cut — several rulings below exist BECAUSE
of that review; do not relitigate without re-reading it).

- **Repeated identical calls — grepSearch/globWorkspace ONLY.**
  `withRepeatedCallGuard` in
  `apps/desktop/src/assistant-server/tool-call-loop-guards.ts` tracks stable,
  recursively key-sorted arguments independently for each `(threadScope,
  toolId)`. Calls one and two run normally, call three runs and stamps a
  warning, and call four or later is REFUSED WITHOUT calling `run` at all.
  Different arguments reset ONLY that tool's streak; an intervening call to
  another tool NEVER resets it. **`readWorkspaceFile` deliberately does NOT
  use this mechanism** — an args-only streak has no way to know the file
  changed between calls, so it would either permanently refuse a legitimate
  re-read after an edit (the refusal fires BEFORE the file is ever checked) or
  stamp a false "results have not changed" warning on content that did change.
  `readWorkspaceFile` relies solely on the mtime-aware window guard below,
  which always re-reads the file first and can therefore never go stale that
  way.
- **The streak only advances on a call that PRODUCES a result.**
  `peekRepeatedToolCall` is read-only with respect to the observable streak
  (it never mutates `repeatedToolCalls`); `withRepeatedCallGuard` calls it
  BEFORE `run`, then calls the mutating `commitRepeatedToolCall` only AFTER
  `run` resolves. A call that throws (transient ripgrep/fs error) is never
  committed, so it never advances the streak and never falsely tells the model
  "the result already in context" when no attempt ever produced one. The peek
  does separately promote cross-mechanism thread-scope LRU bookkeeping, as
  detailed under the bounded-state ruling below.
- **The warning is its own field, never folded into `hint`.** The grep/glob
  purpose-built projectors' continuation logic returns its offset-form
  continuation (and skips `hint` entirely) whenever the page was already
  trimmed by the output-char budget — exactly the large/expensive repeats this
  guard exists to stop. `withRepeatedCallGuard` therefore stamps
  `result.loopGuardWarning` (mutated in place, never a spread into a new
  object — the WeakMap-keyed telemetry in `tool-call-telemetry.ts` is tagged
  onto the SAME object and a spread would silently drop that tag). Both
  projectors render `loopGuardWarning` as its own `warning:` line
  unconditionally, the same way they already render `liveNote`/`probeNote`,
  so it survives regardless of the continuation branch.
- **Unchanged file-read windows.** `checkUnchangedReadWindow` keys a fresh
  `readWorkspaceFile` request by root, normalized workspace path, requested
  `startLine`/`endLine`, the EFFECTIVE `maxChars`, and observed mtime — two
  reads of the same range with different `maxChars` are NOT the same read (a
  bigger budget can return content the smaller one omitted), so `maxChars`
  participates in the key. The first read returns content, the second
  unchanged read returns `dedup: true` with `UNCHANGED_READ_STUB_MESSAGE`, and
  the third returns the same non-throwing hard-refusal shape used by the
  repeated-call guard. An mtime change resets the window (the model's next
  identical-args request always sees the edit — this is what makes it safe for
  `readWorkspaceFile` to skip the args-only streak above). A request with
  `cursor` is a continuation and MUST NEVER enter this guard; paging must
  continue normally.
  - **Checked only AFTER a page is built, and only when it is NOT truncated.**
    `runReadWorkspaceFile` calls `checkUnchangedReadWindow` after
    `fitReadWorkspaceFileResult` has already produced `selected.result` — never
    right after the file scan, where a later page-fitting failure (e.g.
    `maxChars` too small to advance) would otherwise record an observation for
    a call that never produced a page, priming the model's very next
    (corrected) retry to look like a repeat of a read that never happened. And
    only when `selected.result.truncated === false`: stubbing a TRUNCATED page
    would discard the only `nextCursor` pointer to the rest of a large file and
    misreport `truncated: false`/a full `endLine` — the stub's metadata always
    comes from the real `selected.result`, not a re-derived guess.
- **Repeated string-replace failures.** `recordEditFailure` counts only
  consecutive `StringReplaceError` failures whose reason is `ambiguous` or
  `not_found`, keyed by thread, root, and normalized workspace path. On failure
  three and later, `runStringReplaceWorkspaceFile` APPENDS
  `EDIT_FAILURE_HINT_MESSAGE` to the fuzzy matcher's own message rather than
  replacing it — the matcher's diagnostic (matched line numbers, the "diverged
  after N lines" cascade) is the single most actionable fact for widening
  `oldStr`, and replacing it would throw away exactly what the model needs most
  after two prior failures. `no_op` NEVER increments this streak. A successful
  `stringReplaceWorkspaceFile` OR a successful `writeWorkspaceFile` to the same
  path resets the streak — a full rewrite is the recovery path the hint itself
  recommends, so it must count as recovery too.
- **One shared scope authority.** Every mechanism MUST receive
  `threadScope = readStateScope(runtimeData)` from
  `apps/desktop/src/assistant-server/workspace-file-staleness.ts`; no tool may
  derive a second thread key. This intentionally shares identity with the
  read-before-write mtime tracker.
- **Refusal is data, NEVER an execution error.** `buildRepeatedCallRefusalResult`
  returns `{ok:false, refused:true, error}` so the model receives a compact
  decline and the run remains alive. For grep/glob, the object intentionally
  lacks `outputMode`: `parseGrepToolResult` and
  `parseGlobWorkspaceToolResult` reject it with
  `ToolProjectionInputRejectedError`, then `projectExistingModelOutput` in
  `packages/agent/src/mastra/tool-model-output.ts` catches that explicit marker
  and emits the generic bounded projection. Other projector errors still fail
  loudly. `readWorkspaceFile` already uses the generic JSON projection, so its
  refusal passes directly.
- **The unguarded read caller is load-bearing.** `workspace-context-tools.ts`
  calls `runReadWorkspaceFile` directly for bulk context and MUST see no loop
  guard or widened return. The three-argument overload therefore remains
  exactly `Promise<ReadWorkspaceFileResult>`; ONLY the four-argument overload
  used by `buildDesktopAssistantTools` can return `LoopGuardRefusalResult`.
- **Dedup still records knowledge.** Before an unchanged-read stub or refusal
  returns, `runReadWorkspaceFile` MUST call `recordKnownFileMtime` with the
  loop guard's scope and the file's canonical path/mtime. The bytes are not
  resent, but the thread's knowledge is current; omitting this write corrupts
  the next write-staleness decision.
- **Ephemeral, not factory-reset state — and now bounded (BST-1197).** The three
  maps are process-local. `resetToolCallLoopGuards` serves test isolation AND
  one production caller: after BST-1192 commits a stale-read projection
  rewrite batch, it resets that exact `readStateScope(runtimeData)` thread. A
  dedup stub must never refer the model to an earlier result the newly
  committed overlay will collapse on the next replay. This mirrors
  `packages/agent/src/tools/file-read-state.ts` and its `resetFileReadState`
  and MUST NOT be wired into factory reset. Each per-thread map holds at most
  the exported `MAX_KEYS_PER_THREAD_SCOPE` (256) keys, using that module's
  insertion-order, delete-then-set LRU-on-write technique. One shared activity
  tracker across all three mechanisms holds at most the exported
  `MAX_TRACKED_THREAD_SCOPES` (256) thread scopes; overflow evicts the
  least-recently-active scope from every store. The unchanged-read and
  edit-failure mechanisms are intentionally whole-thread, non-consecutive
  dedup: their designed behavior is for a key to survive arbitrary unrelated
  activity between touches. A tight 8-key cap defeated that behavior in
  ordinary multi-file sessions (PR #2332 review), so 256 preserves useful
  history while remaining bounded. Repeated-tool state only has grepSearch and
  globWorkspace entries in practice (at most a couple per thread), making the
  same generous cap harmless headroom there.

  Every write path (`commitRepeatedToolCall`, `checkUnchangedReadWindow`, and
  `recordEditFailure`) promotes its scope through `getOrCreateScopeMap`, and the
  read path (`peekRepeatedToolCall`) promotes it through the same shared
  `touchThreadScope`. The read-path touch is required because a refused call
  returns before commit: without it, a thread actively stuck in a refuse-only
  loop could be evicted as falsely idle and have its refusal silently undone
  (PR #2332 review, threads 1 and 3). This promotion changes only LRU
  bookkeeping; peeking still never advances the observable successful-call
  streak. The bounds remain lossless: a key or scope is forgotten only after
  `MAX_KEYS_PER_THREAD_SCOPE` or `MAX_TRACKED_THREAD_SCOPES` OTHER identities
  are touched in between, respectively. At that point the activity is no
  longer meaningfully contiguous, so restarting at fresh/one is correct.

Paired proofs live in `tool-call-loop-guards.test.ts`,
`loop-guard-projection-round-trip.test.ts`,
`assistant-tools-read.integration.test.ts`, and
`string-replace-workspace-file-live-loop.test.ts`. When changing this flow,
update this section and those tests.
