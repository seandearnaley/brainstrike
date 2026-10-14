# Run usage attribution and the live tick — evidence

Supports `docs/agents/assistant-persistence.md` §
"CONTEXT USAGE METER (TOKEN AWARENESS)". Read this before proposing to change run_kind attribution, the two writers, the live-sum gate, or OM pricing in the wider cost surfaces.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

- Thread-total headline + run-kind attribution (BST-953): every
  `brainstrike_assistant_run_usage` row carries `run_kind`
  (`'chat' | 'subagent' | 'compaction-summary' | 'om-observation' |
  'om-reflection'`, migrations 077/090, sole author since BST-1651 retired the
  repository bootstrap mirror; CHECK-constrained, default `'chat'`). TWO
  writers, never overlapping: the renderer writes ONLY parent `'chat'` rows
  (the `handleUsage` message-finish tap); the desktop server writes ONLY child
  rows, from the `child-run-usage` StreamChunk
  (`persistDesktopChildRunUsage` in apps/desktop/src/assistant-server/run-persistence.ts, a
  DUPLICATION-NOTE mirror of `recordRunUsage`). Child sources:
  - subagent: `onDelegationComplete`'s aggregate usage
    (`createDelegationConfig.onChildUsage` → per-leg `DelegationUsageCapture`
    queue drained by the stream generator). Provider-exact; model/provider =
    persona pin ?? parent run. Bound desktop runs include native parent-run,
    tool-call and child-thread/resource identity. The existing writer reconciles
    one row per invocation against the original host leg (migration 128), so
    duplicate delivery and cumulative snapshot resume do not double-count.
    Bound authorization or write failures propagate before the UI refresh;
    they never fall through to the legacy unattributed insert. Historical rows
    retain NULL invocation keys. Deleting a child also NULLs only those keys,
    preserving already-spent root totals. Numeric usage is retained on root
    deletion as before; it is excluded from the existing transcript sidecar
    deletion list and cleared by factory reset. See assistant-subagents.md for stream ordering
    and the exact limits of the cumulative-usage proof.
  - OM cycles: `data-om-observation-end` / `data-om-buffering-end` chunks
    (`tokensObserved`/`observationTokens` and `tokensBuffered`/`bufferedTokens`)
    mapped in `mapObservationalMemoryCycleEnd`. These are Mastra's LOCAL tokenx
    estimates (`estimated: true`) — the UI must label OM figures "est.", and
    attribution is ONLY the run's resolved observer target
    (`resolveDesktopObserverUsageTarget`): never the chat model, unattributable
    rows are dropped with a warn, and `provider === 'local'` rows are skipped
    (unbilled — an unpriceable row would blank the whole thread cost).
  Child rows reuse the PARENT `runId`, so the Task Ledger's per-run totals
  include them automatically. `getThreadCumulativeUsage` groups by
  (provider, model, run_kind) and sums cache classes UNCONDITIONALLY (the
  savings line needs them for billed rows too); `resolveCumulativeUsageDisplay`
  (assistant-cumulative-usage.ts) derives in/out totals, by-source subtotals,
  and net cache savings (read discount − write premium, per-model registry
  rates; ABSENT when any cache-bearing model lacks rates). The meter chip leads
  with the THREAD TOTAL (+cost when priceable); the context fraction moves to
  the ring/title/popover ("Context N% full" section). Live tick: the renderer
  taps `run.step.finished` run events' `promptTokens`/`completionTokens`
  (`onStepUsage` → `recordLiveStepUsage`, summed per in-flight run) and the
  forwarded `brainstrike.child-run-usage` aui-data part (`onChildRunUsage` →
  cumulative re-read; the server AWAITS the row before forwarding, so the
  refresh never reads pre-write state); the live sum is CLEARED on three paths.
  Two are settle-side — `handleUsage` (only AFTER the post-write refresh, so the
  total never dips and jumps) and the wrapped `completePreparedRequest` on a
  cancelled/failed terminal status (the abort-gated tap never delivers those
  runs' finish). The third is RUN START: the wrapped `prepareRequestData`
  resets the thread's sum synchronously before composition awaits, because
  every clear keys off the CURRENT selection, so switching away mid-stream
  strands the old thread's partial sum permanently — its later steps and its
  settle-clear both land on the newly selected thread.
  A fourth path used to sweep on thread selection; BST-1652 replaced it with a
  READER-side gate, because a sweep is an effect and an effect fires after
  paint. `ContextUsageMeter` gates the recorded sum on `isRunning === true ||
  settlingRunUsageByThread[key]` and passes the gated value to the popover.
  **The gate and the run-start reset are a required pair and neither covers the
  other's case**: the gate hides a stranded sum while the thread is idle, and
  the reset removes it before the next run on that thread can expose and
  accumulate onto it. Without the reset, a new run re-opens the gate on the
  retained tokens and the headline stays inflated with its cost suppressed for
  the whole run.
  The settle marker is the gate's other half, and it is not optional:
  `isRunning` goes false at STREAM FINISH, while `handleUsage` deliberately
  holds the live sum until the post-write refresh absorbs the row. Gating on
  `isRunning` alone drops the whole run from the headline for that window and
  jumps it back when the refresh lands — the same dip the write ordering exists
  to prevent, on EVERY run rather than in an edge case. `handleUsage` claims
  the window with `beginLiveRunUsageSettle` once past the no-sink guard —
  without a durable write there is nothing to protect — and the release is
  STRUCTURAL: the chain's `finally` plus a `catch` for a synchronous throw that
  never reaches it. That is not belt-and-braces. A claim that outlives its sum
  is strictly worse than no claim, because it holds the gate open on an idle
  thread and the headline stays inflated until some later run on that thread
  settles; the run-start reset is the second self-heal, since
  `clearLiveRunUsage` drops the marker together with the sum.
  The claim is keyed to the SELECTED thread, like every other write here
  (`selectedMemoryThreadId ?? 'active'`), so the thread a user walked away from
  mid-stream never enters the window — but the claim for the finishing run
  lands on whatever thread is selected when it settles. A stranded sum on THAT
  thread is briefly visible for the duration of the durable write, then wiped
  by the same `clearLiveRunUsage`. A repo-backed
  thread with no rows yet hydrates the honest ZERO baseline
  (`EMPTY_THREAD_CUMULATIVE_USAGE_DISPLAY`) so the FIRST run's live steps
  render as the thread total; a failed load stays null (never $0). While live
  tokens are included, the chip suppresses the durable cost and the popover
  qualifies it "(excl. live)" — a current total must not sit beside a lagging
  price.
- OM rows in the WIDER cost surfaces (settled ruling, BST-953 review): the
  daily-spend guardrail, cross-root usage, and run-ledger analytics aggregate
  `run_usage` without a `run_kind` predicate, so `'om-observation'`/
  `'om-reflection'` rows flow into them priced at the observer model's
  registry rate like any unbilled row. This is DELIBERATE: the tokens are
  genuinely billed by the provider; Mastra's tokenx content-size figure is a
  weaker (under-)estimate of their count, and EXCLUDING them would silently
  under-count real spend — the worse failure for a budget guardrail. Those
  surfaces already qualify their totals as captured-usage estimates;
  per-source itemization outside the context meter is future work, not a
  correctness gap. Subagent rows are provider-exact and belong in all of them.

