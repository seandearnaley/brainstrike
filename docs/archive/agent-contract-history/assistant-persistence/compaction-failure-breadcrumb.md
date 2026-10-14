# Swallowed-compaction breadcrumb — evidence

Supports `docs/agents/assistant-persistence.md` §
"SWALLOWED-COMPACTION BREADCRUMB KIND". Read this before proposing to change the reachable throws, the one-kind ruling, the latch key, the cap, or the arm-on-delivery pairing.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`compaction.failed` is an additive `ASSISTANT_RUN_EVENT_KINDS` member recording
that `runConversationCompactionBeforeStream`
(packages/assistant-service/src/stream-init-compaction.ts) caught a throw from
the pre-request pass, so THIS turn reached the provider uncompacted and over
budget. The catch itself is correct and stays: a compaction failure must never
kill the user's turn. What it must not do is degrade in silence — that is the
`AGENTS.md` no-silent-degradation rule, and the silence is what let BST-1707's
live defect (`moonshotai/kimi-k3`'s budget derivation throwing on EVERY turn of
a recommended coding model) survive from `2966627ff` until someone read the
arithmetic.

WHAT CAN STILL REACH THAT CATCH, verified against `runPreRequestCompaction`
after BST-1707 landed (apps/desktop/src/assistant-server/conversation-compaction.ts):

- All three `resolveCompactionInputBudget` throws — missing run provider/model;
  a present-but-unusable `agentLoop.inputTokenLimit` (BST-1707's new throw,
  reachable because the desktop assistant HTTP path does not sanitize
  `agentLoop`; only the IPC tool path's `sanitizeAgentLoop` does); and
  `Unknown compaction input budget for <provider>/<model>.` for a run carrying
  no `agentLoop` whose model is not in the catalog (dynamic ollama/lmstudio,
  raw clients).
- The two trusted-lookup guards: `Conversation compaction requires the trusted
  compaction overlay lookup.` (via `loadMessages`, so on the unprojected AND
  projected loads) and `... the trusted tool projection lookup.` (via
  `loadProjectedState`).
- A `memoryStore.listMessages` rejection inside `loadMessages`, and a
  `runRecencyPruneScan` DB failure.
- Everything on the DETERMINISTIC COMMIT path, which runs outside the agentic
  try/catch on the baseline-dominates branch and again inside the agentic catch
  as the fallback: `Compaction candidate <id> has no valid creation time.`,
  `memoryStore.saveMessages`, `Assistant message <id> has conflicting branch
  topology.`, and `recordCompactionRange` DB errors.

Two entries in BST-1737's own enumeration do NOT survive that reading and are
recorded here so they are not re-added:

- `AgenticCompactionSummarySchemaError` does not reach this catch.
  `isNonRetryableSummarizerFailure` returns true for it, so the pass handles it
  internally and routes to the deterministic fallback; it only reaches the outer
  catch indirectly, if that fallback's commit then throws.
- Prompt-baseline lookup failures do not reach it either. The inner
  `resolvePromptBaselineTokens` wrapper catches them, logs
  `conversation_compaction_baseline_corrupt` /
  `conversation_compaction_baseline_lookup_failed`, and returns zero.
  `usageForSummary`'s "requires the run provider and model" throw is likewise
  unreachable from here: `resolveCompactionInputBudget` already demanded both
  before any summarizer ran.

SURFACE AND SHAPE. Modelled on `mcp.tools.unavailable` (see that section above),
which was filed for the same class of problem. Status is always `'failed'`,
never `'running'` — the pass has already finished, by throwing, when the row is
minted — so it declares no terminal and can never leave a row spinning. Filed
under `NEVER_RUNNING` in `assistant-run-event-pairing-contract.test.ts`; that
guard can force a kind to be CLASSIFIED but cannot check the classification
against the emitter, so `stream-init-compaction.test.ts` asserts the emitted
status directly. Deliberately NOT `run.failed`: the turn is healthy and
completes, and `data-stream-mapper` derives `thread_runs.error` from
`run.failed`, so that spelling would persist a degraded turn as a failed one.

It is in `isAlwaysVisibleRunEvent`, and that membership is LOAD-BEARING for the
reason spelled out on `mcp.tools.unavailable`: run-event rows are hidden unless
background activity / Developer detail is on, so a kind added to the contract
alone would still report nothing to the user it exists for. Nothing else cards
this fact — the user's only other symptom is a later provider context-overflow
error naming an unrelated cause, or quietly degraded output.

ONE KIND, REASON IN THE ROW. There is no `compaction.budget.failed` /
`compaction.schema.failed` taxonomy. The discriminating fact is already written
at each throw site and travels in `detail` and `metadata.reason`; a
hand-maintained classifier would have to be extended for every new throw and
would bucket the next unanticipated one into "other" — re-creating exactly the
defect this kind exists to end. The reason is redacted and length-bounded by
`boundRunEventReason` (`@brainstrike/assistant-contract/run-events`) before it
becomes durable metadata or a rendered row; that helper is BST-1602's
`boundMcpDiscoveryReason`, promoted so the two callers share ONE copy of the
credential-stripping regexes. Promotion WIDENED that helper's input, and the
patterns had to widen with it: BST-1602's only caller was MCP discovery, whose
transports are HTTP, so the userinfo and query patterns were anchored to
`https?://`. Compaction failures reach `memoryStore` reads/writes,
`runRecencyPruneScan`, and `recordCompactionRange`, whose driver errors quote
`postgres://user:pass@host/db` — which both anchored patterns passed straight
through into durable metadata and an always-visible row. They now match any
`scheme://`, pinned by `postgres`/`postgresql`/`redis`/`mongodb+srv` cases in
`run-events.test.ts`; an HTTPS URL merely *named* like a database (the original
`https://user:hunter2@db.test/x?token=sk-live` fixture) does not exercise this
and must not be mistaken for coverage of it. The row does NOT carry the resolved budget: the
failure class where a budget would be most informative is precisely the one
where no budget was ever resolved.

ONCE PER (THREAD, REASON), not per turn. Most of what reaches this catch is
sticky — an unknown model, a malformed `agentLoop`, a missing overlay lookup —
and fails identically on every turn, so an unlatched row would grow one
identical always-visible entry per turn forever, push real content out of the
timeline, and train the user to ignore it. The latch keys on the reason and
never on the thread alone, so it can never hide a DIFFERENT failure; the `warn`
log is NOT latched, so per-turn operator evidence is never lost. The latch is an
in-memory `Set` with no persistence, mirroring
`warnedBaselineExceedsTargetThreadIds` in `conversation-compaction.ts`: a
restart re-arms it. It is keyed on the reason's SHAPE and capped since
BST-1744 — see the next section, which supersedes #3119's "no eviction".

THE KEY IS THE SHAPE OF THE THROW, AND THE SET IS CAPPED (BST-1744; raised by
the Claude review of #3119 and deliberately deferred there). #3119 keyed on the
whole bounded reason, which defeated the latch outright for the two reachable
throws that embed a per-message id — `Compaction candidate <id> has no valid
creation time.` and `Assistant message <id> has conflicting branch topology.` —
and for any driver error quoting a per-row identifier. A new reason every turn
is a new key every turn, so the row was never deduplicated and the `Set` grew
one entry per failing turn. The opposite edge was real too, and reproduced by
the test that now pins it: because the key used the ALREADY-TRUNCATED reason,
two failures agreeing on their first 199 characters collapsed onto one entry and
the first silenced the second.

BOTH HALVES, NOT EITHER ONE. Neither candidate closes this alone, which is why
the ruling took both:

- `compactionFailureKey` digests the SHAPE of the untruncated message — volatile
  tokens masked, then sha256. Shaping alone cannot be proven complete:
  `mastra_messages.id` is free-form `TEXT` (migration 117), so an id in a shape
  the patterns do not recognise still mints a fresh key every turn.
- `MAX_TRACKED_COMPACTION_FAILURES` caps the set at 512 with drop-oldest
  eviction. The cap alone would have bounded memory while leaving the per-turn
  row noise — the timeline noise this latch exists to prevent — fully in place.

THE MASKING IS NOT THE CLASSIFIER THIS KIND REFUSED. ONE KIND, REASON IN THE ROW
(above) rejected a hand-maintained taxonomy because it would need extending for
every new throw and would bucket the next unanticipated one into "other". The
shaping has neither property: there is no registry of known throws, and an
unrecognised throw keys on its own text rather than being bucketed anywhere. Its
failure direction is UNDER-merging — at worst an extra visible row — never
over-merging across distinct throws, which would be a silence. The row still
renders the FULL unnormalized reason, id included: normalization is KEY-ONLY.
State the limit of that precisely, because #3138's first draft overstated it:
the user keeps the id of the FIRST message wedged in a given shape. A second
message wedged the same way deduplicates against it and never reaches a row, so
its id survives only in the unlatched `warn`. That is the deliberate price of
not minting a row per turn, not an oversight.

TWO VOLATILE TOKEN CLASSES, BOTH EVIDENCE-BACKED: canonical UUIDs (both
id-bearing throws take theirs from `randomUUID`) and ISO-8601 timestamps (the
compaction fixture in `run-events.test.ts` quotes a creation time, and a driver
error that does so changes on every turn). SHORT DIGIT RUNS ARE DELIBERATELY NOT
VOLATILE: `ollama/llama3.2` and `ollama/llama3.3` are DIFFERENT failures, and a
blanket digit mask would let the first permanently silence the second — the one
thing this latch must never do. Do not widen these patterns to chase a residue
the cap already bounds.

THE KEY IS BUILT FROM THE UNTRUNCATED MESSAGE, through `redactRunEventReason` —
`boundRunEventReason` minus the bounding, split out by BST-1744 so there is
still exactly ONE copy of the credential patterns and ONE extraction. #3138's
first pass skipped redaction altogether, reasoning that the key never leaves the
in-memory `Set`; the Claude review of that PR showed the reasoning was aimed at
the wrong target. It is a fair objection to COPYING the patterns and no
objection at all to REUSING them, and redaction is not secrecy here — it is part
of the SHAPE. A message quoting a rotating secret (a provider auth error, a
signed URL, a session id) otherwise mints a fresh key on every rotation: this
ticket's own defect, relocated from ids to credentials, and no less reachable
than the timestamp case. Sharing one extraction also keeps the key describing
the same text the row renders; a second `value instanceof Error ? …` would be
free to drift the moment either side grew a case, and a drifted key merges or
splits rows the user sees differently. Both are pinned — "deduplicates a reason
whose only variable part is a rotating credential" and "keys a non-Error throw
from the same text the row renders".
Hashing is what makes an untruncated key affordable: a fixed-width digest turns
the cap into a real BYTE bound rather than a bare entry count. Length framing is
retained even though a fixed-width digest is already self-delimiting — it costs
nothing, and it keeps the ruling below and its test intact.

DROP-OLDEST, NOT LRU. The dedupe fast path only READS the set, so recency would
have to be written on every suppressed turn, and first-seen order is already
exact because a key the set holds is never re-added. Eviction costs the evicted
failure ONE more visible row if it recurs — a repeat row, never a silence, the
same direction every other ruling on this latch picks. NAME WHO DOES THE
EVICTING: the keys are per-thread but the cap and the eviction order are
process-GLOBAL, so a single thread wedged on an unmasked id is the noisy
neighbour — within 512 such turns it clears every OTHER thread's entry and each
of them re-reports once. That cost is bounded and is a repeat row rather than a
silence, so it is accepted. A per-thread sub-cap was considered and rejected: it
needs its own eviction policy, and it would let one thread's many distinct
failures evict each other, trading a bounded repeat row for a possible silence.
The idempotency guard in
`latchCompactionFailure` is load-bearing rather than a fast path: `markReported`
is documented idempotent, and THE LATCH ARMS ON DELIVERY (below) accepts two
turns committing the same key; at the cap, a commit that added nothing would
otherwise evict an unrelated thread's entry.

Pinned by `stream-init-compaction.test.ts` ("BST-1744: the key is the SHAPE of
the throw, not its literal text"). Every guard is mutation-proven: removing
either masking pattern, widening the masking to all digit runs, keying on the
bounded reason, removing the eviction, and removing the idempotency guard each
fail exactly the intended test and no other.

NO THREAD ID, NO LATCH. `runtime.memory?.threadId` can be absent, and keying
every unidentified turn under one shared bucket would let a single delivered row
permanently silence a DIFFERENT conversation failing the same way — precisely
the invariant the reason-keying exists to protect, broken where the latch knows
least. Such a turn therefore always mints, and its `markReported` is a no-op
(`NEVER_LATCHED`).

THE KEY IS LENGTH-FRAMED, NOT DELIMITED. `<threadId.length>:<threadId><reason>`
is unambiguous for any pair without needing a character that cannot occur in
either. It was a NUL separator until #3119's own Claude review quoted that line
and reproduced the separator as a real NUL character in its review text:
`scripts/claude-review.mjs` publishes the disposition with
`execFileSync('gh', […, '--body', body])`, Node refuses an argv string
containing a NUL, and the review gate went red at two different heads
(`a53612d266`, `9b66bfd7fb`) with the review itself complete and validated —
"Publication failed: The argument 'args[6]' must be a string without null
bytes." `lint:no-raw-nul-bytes` does not catch this: the source held the ESCAPE,
which is legal, and the raw byte only appeared two systems downstream. A key
that never leaves an in-memory `Set` must not carry a byte the rest of the
toolchain cannot transport, and the comment on it names the byte rather than
spelling the escape for the same reason. The framing is pinned by a test whose
thread ids and reasons concatenate identically ("keeps a thread/reason boundary
that bare concatenation would collapse").

THE LATCH ARMS ON DELIVERY, NEVER ON MINT (Codex review of #3119). Minting
happens while the outcome is still being CONSTRUCTED — `initializeAgentStream`
then awaits `resolveInitialAgentStream` and only afterwards wraps the prelude.
Adding the key at mint time meant a rejection in that await, or a returned
stream nobody consumes, produced a row that reached neither `observe()` nor
persistence while every later turn with the same thread and reason stayed
silent for the life of the process — this ticket's own defect, reborn inside its
fix, and invisible. So `compactionFailureChunk` READS the key and returns the
chunk bound to a `markReported` commit; `prependStreamChunks` calls it after the
consumer has taken the chunk and come back for the next one. The pairing is one
value (`PreRequestCompactionFailureBreadcrumb`), not two sibling fields, so the
row cannot be emitted without arming the latch nor the latch armed without
emitting the row. The accepted cost: two turns that fail identically before
either prelude is consumed both mint a row, which is honest — both turns really
were sent uncompacted — and is the only direction that cannot suppress a row
nobody ever saw. Delivery is NOT proof of persistence or of rendering: a wrapper
further out could still drop the chunk, and the latch would arm anyway. It
closes by far the widest part of that window, and what remains costs one
thread's repeated row rather than a permanent process-wide silence — do not read
"delivered" here as "durable". Pinned by `stream-init-compaction.test.ts` ("does NOT latch a
breadcrumb the stream never delivered", "leaves the latch UNcommitted for a
stream that is never consumed"), and the once-per-(thread, reason) test now has
to deliver the first row before the second turn is deduplicated against it.

A CANCELLED TURN MINTS NOTHING. When `input.signal.aborted`, the warn still
fires but no row is minted and the latch is untouched: `run.cancelled` already
reports a cancelled turn, and a "compaction unavailable" row would be a false
alarm on every cancellation landing mid-pass.

EMISSION PATH. The breadcrumb rides the SAME stream prelude the compaction
summary's `child-run-usage` chunk already rides
(`withCompactionPreludeChunks`, failure chunk first), so it reaches the
`observe()` wrapper — and therefore run-event persistence and the timeline —
through the ordinary run-event chunk path, with no second seam to keep in sync.

