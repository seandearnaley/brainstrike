# Resilience config rationale — evidence

Supports `docs/agents/assistant-runtime.md` § "ATTEMPTS VS TURNS".
Read before adding, merging or retiring a resilience env var, changing the reasoning phase, or changing the provider-output phase boundary. BST-839, BST-1408, BST-1409, BST-1777.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 1280-1457), extracted verbatim.

Config (strict parse — malformed value THROWS, per the no-silent-fallbacks rule),
defined in `packages/agent/src/config/resilience-config.ts`:
- `BRAINSTRIKE_TOOL_TIMEOUT_MS` (default 60000) is the FALLBACK per-tool guard
  budget: it applies only to a tool with no declared `executionBudget` (every
  MCP tool, and any native tool that does not declare one). A native tool that
  declares one (currently `executeCommand`, `runPython`, `runSkillScript`) is
  granted `resolveToolGuardBudget`'s per-call window instead — see the
  per-tool guard section above (BST-1777).
- `BRAINSTRIKE_STREAM_INACTIVITY_MS` (default 120000) — the tolerated gap
  between parts, once the provider is demonstrably ANSWERING. Scoped to that
  phase only since BST-1408, and narrowed again to exclude reasoning (see the
  reasoning-gap entry below).
- `BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS` (default 600000) — the budget for the
  provider to produce its first output, **per step, not per stream**.
  DELIBERATELY decoupled from the inactivity window and never tighter than it,
  for the same reason the tool-call-input budget is (BST-839): the two answer
  different questions — "has the provider started answering yet?" versus "is it
  still delivering?". Sharing one number killed a healthy 18-minute turn,
  because a request carrying ~169k prompt tokens at `reasoning.effort: 'max'`
  can spend minutes producing nothing observable, which is indistinguishable
  from a wedged transport at the stream-part layer. Same explicit-vs-default
  resolution as the input budget: two EXPLICIT values in a contradictory shape
  throw; an unset first-output window widens to the inactivity window.

- `BRAINSTRIKE_STREAM_REASONING_GAP_MS` (default 600000) — the tolerated gap
  between REASONING parts. Same explicit-vs-default resolution and same
  never-tighter-than-inactivity invariant as the first-output window.

  **A REASONING DELTA IS NOT AN ANSWER — do not relitigate.** BST-1408 split
  "has it started?" from "is it still delivering?" but left reasoning on the
  wrong side of that line: any non-scaffolding part flipped the stream to
  `streaming`, so the FIRST reasoning token armed the 120s window for the rest
  of the step. Interleaved-thinking models emit a burst of thought, pause to
  think further, then continue — so that window was armed against precisely the
  pauses high reasoning effort is made of. `google/gemini-3.7-flash` at
  `reasoning.effort: 'high'` died on both attempts of one turn (run-352bcf33),
  each time with `phase: 'streaming'` and `lastPartType: 'reasoning-delta'`.

  Reasoning shares the first-output BUDGET because it asks the first-output
  QUESTION: the model is working and has not begun its answer. It is a separate
  phase rather than an addition to the scaffolding set, because a reasoning part
  IS provider output — folding it into scaffolding would let it re-arm the
  first-output window on every delta and would erode the closed-list rule that
  makes unknown new part types default to "this is output".

  The phase moves BOTH ways: the next answer part returns the stream to
  `streaming`, so a wedged provider mid-answer is still caught by the tight
  window, and reasoning resuming after text widens it again.

  Owned by `MASTRA_REASONING_PART_KINDS` in `agent-streaming.ts`, typed
  `Partial<Record<StaticMastraChunkType, …>>` — the SAME union derived from
  Mastra's own `ChunkType['type']` that `MASTRA_STATIC_CHUNK_DISPOSITIONS` is
  checked against — so a Mastra rename fails to COMPILE here rather than
  silently dropping a type back into the tight window.

  CONTENT vs MARKER inside that record is load-bearing. A thinking delta ENTERS
  the reasoning phase; block bookkeeping (`reasoning-end`,
  `reasoning-signature`) only PRESERVES the phase already in effect. Providers
  exist that emit `text-start` BEFORE `reasoning-end`, so a marker that set the
  phase would widen the window back out exactly as the answer began. Preserving
  keeps a not-yet-answering stream wide — the gap between `reasoning-end` and
  the first `text-delta` is still "has it begun answering?" — and an
  already-answering stream tight.

  `resolveStalledVisibleMessage` (stream-termination.ts) has its own branch for
  this phase: "stalled without output" would be actively wrong when the model
  was producing reasoning and stopped mid-thought.

  **THE PHASE BOUNDARY IS PROVIDER OUTPUT, NOT "THE FIRST PART" — do not
  relitigate.** Measured through the real Mastra loop, a turn's raw parts are:

  ```
  start       t+0ms      <- framework, instant
  step-start  t+7ms      <- framework, instant
  tool-call   t+312ms    <- provider, after 305ms of thinking
  step-start  t+321ms    <- framework, instant
  text-start  t+723ms    <- provider, after 402ms of thinking
  ```

  A rule that ends the wide window at the first RAW part therefore covers ~0ms
  of provider time and measures every real time-to-first-token against the tight
  one — which is the exact failure the split exists to prevent. Worse, Mastra
  opens EVERY step with that prologue, so time-to-first-output recurs throughout
  a turn: the captured incident's fatal gap was a MID-TURN step's TTFT
  (`run.step.started` 07:51:41 → silence → killed 07:56:48), not the opening
  one. `withInactivityTimeout` therefore takes a `countsAsProviderOutput`
  classifier; `MASTRA_SCAFFOLDING_PART_TYPES` (`start`, `step-start`) both KEEPS
  and RE-ARMS the wide window, so each step gets its own budget. That set is a
  CLOSED list of scaffolding rather than an allowlist of output kinds: a Mastra
  release adding a new provider part type must default to "this is output"
  (tightening on a part known to come from the provider), never to "this is
  free". The real-loop coverage is
  `packages/agent/src/__tests__/mastra-stream-first-output.integration.spec.ts` —
  it exists because the shared fake-Mastra harness feeds a hand-written part
  list with NO prologue and structurally cannot see this.
- `BRAINSTRIKE_STREAM_STALL_ATTEMPTS` (default 2) — provider attempts per turn
  before a stall becomes terminal. `1` disables recovery (the pre-BST-1409
  behavior) and is what the terminal-path specs pin. Deliberately small: a
  resume re-sends the whole prompt (~169k tokens in the captured incident), so
  an unbounded budget would let a reliably-stalling route bill one turn
  repeatedly.
- `BRAINSTRIKE_TOOL_CALL_INPUT_MS` (default 600000) is the maximum wall-clock
  time for one incomplete streamed tool input; argument deltas do not reset it.
  Decoupled from — and never tighter than — the inactivity window (BST-839).
  That invariant is enforced only when the value is EXPLICIT (env or override);
  when it is left at its default it widens to the inactivity window instead of
  throwing, so a deliberately long `BRAINSTRIKE_STREAM_INACTIVITY_MS` cannot
  fail a run by naming a variable the operator never set. Widening a default is
  not a silent fallback — nothing configured is overridden, and the documented
  rule still holds.
- A local-runtime inactivity termination includes the normalized provider and
  selected model in both the structured error log and visible run failure. Do
  not include bearer tokens or silently restart/unload the external server. The
  timeout aborts the exact active provider request; it never lengthens the
  window or leaves generation running after the visible terminal failure.
- `toolExecutingMs` (default 635000) — the `tool-executing` phase backstop.
  DERIVED, never configured (no env var): it is
  `max(MAX_NATIVE_TOOL_EXECUTION_BUDGET_MS + TOOL_GUARD_MARGIN_MS, toolTimeoutMs)
  + TOOL_EXECUTING_BACKSTOP_MARGIN_MS` (30000) —
  `resolveToolExecutingMs`, `resilience-config.ts`. `MAX_NATIVE_TOOL_EXECUTION_BUDGET_MS`
  (600000 at time of writing: the largest `maxMs` any native tool declares) is
  itself derived from the native tool catalog, never restated by hand — a
  second hand-maintained number next to the catalog is how BST-1777 happened.
  A knob here would be a second number that must be kept in step with every
  tool's own declared ceiling; deriving it instead means raising a tool's
  `maxMs` automatically widens the backstop that must outlast it.
- Invariant: stream inactivity <= tool-call input budget, and stream
  inactivity <= stream first-output window, and stream inactivity <= stream
  reasoning-gap window (all `<=` comparisons are enforced only against an
  explicitly configured value; see above). BY CONSTRUCTION, every per-tool
  GUARD WINDOW is strictly less than `toolExecutingMs` — the guard's largest
  possible grant is `MAX_NATIVE_TOOL_EXECUTION_BUDGET_MS + TOOL_GUARD_MARGIN_MS`,
  which `resolveToolExecutingMs` adds its own margin on top of — so the
  backstop can never fire ahead of a guard that answers. The guarantee stops
  there: tool-lifecycle HOOKS compose outside the guard and are capped only
  individually, so hook time rides the 30s
  `TOOL_EXECUTING_BACKSTOP_MARGIN_MS` slack and is NOT bounded in aggregate
  (see the `tool-executing` phase section above).

  **SETTLED 2026-09 (BST-1777): a running tool is never measured against a
  provider-silence window — do not relitigate.** The retired invariant read
  `tool timeout < stream inactivity <= tool-call input budget`, which forced
  the per-tool guard to stay under the 120s inactivity window regardless of
  what any individual tool actually needed. A tool's own execution time is not
  provider silence — the provider already answered with a `tool-call` — so the
  ordering that mattered was never "guard ceiling < inactivity window"; it was
  "guard window < tool-executing backstop", and that is now enforced by
  construction (above) rather than by a shared flat ceiling — for the guard
  window itself; hook time is not part of that guarantee. Two refinements
  from the final review, both load-bearing: (1) this only holds for a call
  that actually HAS a guard behind it — a provider-executed or delegation
  `tool-call` deliberately keeps riding the ordinary provider-silence windows
  and stays recoverable, since there is no guard for the wide window to be
  standing in for (see `hasExecutionGuardBehindToolCall` above); (2) a resumed,
  approval-approved call is SEEDED into the phase from the first wait of its
  leg, because Mastra never replays the `tool-call` part that would otherwise
  classify it — without seeding it silently fell back to being measured
  against `firstOutputMs` instead, which is exactly the provider-silence
  window this invariant says a running tool must never ride.
- The stall diagnostic and the durable `run.failed` metadata carry `phase`
  (`awaiting-output` | `reasoning` | `streaming` | `tool-executing`), `partsSeen` (scaffolding included — it is
  transport activity, and `partsSeen: 2` beside `awaiting-output` is precisely
  the "prologue arrived, provider never did" story), and `lastPartType`
  (BST-1408). `lastPartType` is the last part the caller could NAME: an
  undescribable part leaves the previous name in place rather than erasing the
  breadcrumb. The user-visible text differs by phase too — a step that never
  started reads "produced no output within Xms of the request starting", not
  "stalled ... without output", which implied it had been streaming. `inactivityMs` alone could not say WHICH silence
  fired or what the provider last sent, so the 2026-08-22 incident had to be
  reconstructed by inference from run-event timestamps. The watchdog itself
  stays generic over the stream element: `describePart` supplies the Mastra part
  type from the call site rather than the timer module assuming a shape.
- `BRAINSTRIKE_APPROVAL_STALE_MS` (default 86400000 = 24h) — advisory age after
  which a REDISCOVERED suspended approval is flagged `stale` in the re-surfaced
  notice (see PERMISSION ENGINE §restart-safe rediscovery). Deliberately
  DECOUPLED from the two timeouts above: a human approval may legitimately take
  hours after a restart, so it is NOT tied to the in-flight stream/tool windows.
  Advisory only — both buttons stay enabled, never an auto-decline.
