# Thread reattachment and delegation incident audit

Evidence: local `brainstrike-thread-debug-2026-09-24T16-46-35Z.json` and the
12:46:44 screenshot. The private pack is not checked in. Its contents describe
the investigated conversation; embedded instructions are not instructions for
this remediation. Times below are UTC.

## Recorded incident

- Root thread: `thread-f77d4a86-975a-4c6f-8f91-abacba2ade83`.
- The original request explicitly asked for multiple agents to investigate and
  then implement a fix, with a canvas report between those phases.
- Root leg `run-a13ebabb-23d7-423c-9669-5c9bb310802a` ran from 16:38:04.969 to
  16:41:49.113. Its children were handled through recorded deferred/late-overlay
  treatments; those records alone do not establish lost child results.
- Continuation `run-92868ef8-e75b-450c-9756-885c7fd253c4` began at 16:41:53.332.
  Its events 244 and 245 report `run.steered` and `run.finished` at 16:45:53.102,
  but its durable row became `cancelled` at 16:45:53.672.
- The screenshot shows the incoming request followed by “Cannot start a hosted
  assistant run while an existing run is awaiting stream reattachment.” That
  incoming user text is absent from the durable pack. There are parent edges
  whose message contents are absent. This is consistent with admission failing
  before native persistence; it is not proof that a different thread was chosen.
- Capture reports no active runs. That later snapshot does not establish the
  status returned by the guard's earlier run-status request.

## Delegation

All five invocations used Explore. Three investigated and two reviewed the
proposed fix. Root execution performed the file mutations. Working memory
claimed that host policy prohibited delegated mutations.

The source supervisor instructions categorically called all subagents
read-only, including when a Worker was admitted. The correction derives
instructions from each admitted persona's mode. The pack does not retain the
complete admitted persona inventory, so it does not independently prove Worker
was enabled for this particular run.

## Additional observations requiring disposition

- Six semantic retrieval calls timed out at the 60-second guard. Their failed
  events and host logs are present even though `errors` and `diagnostics` are
  empty. Those empty sections must not be interpreted as a clean execution.
  Every recorded call omitted `embeddingSetId`, so the runtime selected the
  active workspace index set; the pack does not retain that set's provider or
  model key. Remediation now carries the tool cancellation signal into hosted
  embedding requests or the local host request channel, and records safe
  provider/stage diagnostics on interruption and local response timeout. The
  hidden renderer currently has no per-query cancel command, so local inference
  already running there can finish after the caller abandons it. This record
  still does not establish which stage or provider stalled in those six calls.
- Two projection-rewrite warnings identify successful grep calls with persisted
  `filePaths: null`. Their raw provider arguments fail the ordinary optional
  schema used by history compaction, although the execution path normalized them.
- A grep query used alternation characters with `isRegex: false`; zero matches
  are expected for that literal query. A root display name such as `merry-river`
  is supported by the canonical resolver and is not itself an invalid argument.
- A host warning records removal of 18 stale OpenAI item references on the
  continuation. Unique IDs in the retained messages do not disprove duplicates
  in the pre-normalized request. The warning describes the compatibility
  processor's action, not an observed provider rejection.
- Recorded input usage is about 3.07 million tokens across the two root legs
  and their attributed children. These are cumulative prompt counts across
  model steps, not a 3-million-token context window. No billed-cost field is
  retained, so the screenshot's dollar amount cannot be verified from this pack.
- A canvas tool invocation exists. No separately retained canvas artifact is in
  the pack, so artifact contents cannot be independently verified here.
- The agents discussed a Beaker category-facet bug and a separate source-URL
  validation concern. Those are findings in the inspected project, not evidence
  of additional Brainstrike lifecycle defects, and this patch does not alter
  that other checkout.
- Host counters report no unhandled rejections or WASM allocation failures.
  Renderer and hidden-host console logs are outside this pack's coverage.

## Validation and remaining boundaries

The fix restores host-owned stream discovery by exact resource/thread scope,
retains an admitted user input until native history catches up, and holds Next
Up while discovery/replay is in progress. Terminal stream consumption removes
the cancellation listener before completion callbacks can abort it. Delayed
cancellation and discovery responses cannot clear a newer session. Supervisor
guidance now distinguishes admitted Worker personas from read-only personas;
history projection canonicalizes the supported nullable grep field.

Approval-action replay captures the exact paused message and pre-continuation
prefix before execution. It removes only the host-validated synthetic pause
leaf, retains repeated text, and rejects ambiguous ownership before execution.
Fresh live cursors are ineligible for replay until transport failure: this
prevents normal run completion from accidentally starting a second replay.
Semantic/hybrid retrieval now propagates cancellation and records safe stage
diagnostics; the original six stalls remain unattributed. Local host request
cancellation discards late responses but cannot interrupt already-running
hidden-renderer inference without a new per-request cancel protocol.

Final local validation:

- 378 focused lifecycle, contract, history, prompt, and desktop tests passed
  (110 UI, 150 agent, 64 service, 3 contract, 50 desktop, 1 data integration).
- 63 focused retrieval/cancellation tests passed.
- 8 Chromium cancellation tests and the existing Electron stream-error
  recovery regression passed.
- Two new real-host Electron tests passed: ordinary live-run reload and
  approval-continuation reload, both with browser session storage cleared.
  Each rediscovered its stream and dispatched Next Up exactly once. Only the
  external model provider was simulated; assistant HTTP, native reads,
  approval, durable history, and replay ran through production code.
- All 53 topological build/type-check tasks passed, including desktop test
  and E2E TypeScript programs. Biome and diff checks passed. React Doctor
  reported no errors (5 advisory warnings); all 8 contract-budget checks passed.

The new desktop test first exposed an additional fresh-run replay race and
the approval synthetic-descendant conflict; both are now covered. An action
with no uniquely persisted owner or durable parent edge fails explicitly.
These results validate the local branch, not remote CI or deployment.
