# AGENTS GUIDELINES

You are expected to be precise, tool-driven, and skeptical of your own assumptions.

Key principles:
- Do not claim something is fixed/working without verifying it in code, tests, or logic.
- Do not assume behavior without reading the relevant files.
- The user and the agent can both be wrong; correctness > agreement.
- Prefer saying "I don't know yet; let me check X" over guessing.
- Start with the actual answer, analysis, or current position. Avoid filler openings.
- Match response length to task complexity. Simple answers should stay short.

> **Project Context:** Local-First (Edge-State/CRDT) • AI-Native (MCP/RAG-Optimized) • Web-Second
> *Warning: Latency-critical operations should avoid round-trip API dependencies. Assume state resides on the client.*

---

## ENTRY PROTOCOL

Before starting any task, classify ambiguity and choose the thinnest safe response loop:

- **High ambiguity:** Stop and ask clarifying questions before planning or editing.
- **Medium ambiguity:** State the most likely interpretation, identify the gaps, and wait for confirmation before committing to an approach.
- **Low ambiguity:** Verify mentally, trust the user's intent, and proceed when the change is clear, specific, and low impact.

If requirements, intent, architectural fit, or target state are unclear, ask before writing code. Do not fill gaps with plausible assumptions.

For complex architectural, data, or database tradeoffs, slow down and reason through ownership, scale, failure modes, and alternatives before recommending a direction.

---

## SYSTEMIC CHECKLIST

Trace these dimensions before writing or shipping non-trivial code:

1. **State Ownership:** Where does state live? Preserve a single source of truth, keep the blast radius low, and maintain consistency.
2. **Feedback & Observability:** Where does feedback live? Add or preserve logging, metrics, UI visibility, or test hooks needed for debugging.
3. **Fragility & Coupling:** What breaks if this is deleted? Map dependencies before refactoring or removing code.
4. **Timing & Ordering:** When does timing matter? Account for async work, races, retries, leases, initialization order, and cleanup order.

Verification gate for non-trivial changes:
- State ownership and consistency are clear.
- Feedback and observability paths are adequate for safe debugging.
- Blast radius is mapped and the change is isolated.
- Timing, async patterns, and execution order are safe.
- The solution fits existing codebase patterns.

---

## EXECUTION DISCIPLINE

- Implement the simplest thing that satisfies the request. Avoid premature abstractions, speculative flexibility, and unrequested features.
- Modify only files, functions, and lines directly related to the current task.
- Do not refactor, optimize, or tidy unrelated code during execution. Flag unrelated structural debt after the task instead.
- If uncertain about a fact, convention, statistic, or behavior, say so and verify before relying on it.
- Prefer invariants and existing patterns over defensive layers that hide unclear ownership.

Stop and wait for explicit confirmation before:
- Deleting files or overwriting large swathes of existing code.
- Dropping records, running data migrations, or modifying active schemas.
- Running terminal commands with systemic or irreversible side effects.
- Deploying, pushing, or modifying remote environments.
- Sending external API calls that create, mutate, publish, notify, bill, or otherwise have side effects.

Post-task coding summaries must include:
- **Files Changed:** every touched file.
- **What Was Modified:** one-line description per file.
- **Files Intentionally Not Touched:** boundary validation for nearby code or tempting follow-ups.
- **Follow-Up Needed:** next actions, deferred debt, or "None."

---

NOTE: On this team, the bar is that your final code has a clean build, lint, type check, and unit tests all passing together. That means after you make a change, you’re responsible for running the full suite again and iterating until **everything** is green in the same run. CI is there to double-check, not to tell you what you broke.

Playwright:
- Run non interactively.
- Prefer role/text/data-testid selectors over raw CSS.

Agent DevTools Debugging:
- For local, agent-driven Electron renderer debugging, use:
  `pnpm --filter @brainstrike/desktop dev:agent-debug`
- This is opt-in only. Do not add `--remote-debugging-port` to default desktop E2E.
- Main process debugging remains separate via Electron `--inspect`.

---

## PR CI FLOW

Pull requests use plain GitHub Actions workflows. There is no custom planner,
no generated CI artifact, no CI routing labels, and no local command registry.

Rules:
- Do not add CI labels.
- Do not commit generated CI proof artifacts.
- Do not reintroduce the removed custom proof/planner commands or any custom
  planner script.
- Required PR checks should be the always-present checks from `.github/workflows/test.yml`.
- Web and desktop E2E smoke workflows run on every PR.
- Full web and desktop E2E regression runs on `schedule` or explicit
  `workflow_dispatch`.
- Pushes to `main` run static, unit, build, web smoke, and desktop smoke.

---

## REACT DOCTOR (LINT + DEAD CODE)

`.github/workflows/react-doctor.yml` runs **React Doctor** (`millionco/react-doctor@v2`,
pinned `0.7.1`) on every PR and on push to `main`. It supersedes running standalone knip in
CI: React Doctor performs knip-style dead-code analysis (the bundled `deslop` engine) **and**
~250 React/JS lint rules (Security / Bugs / Performance / Accessibility / Maintainability).
Config lives in `doctor.config.ts`. Plan + baseline: `docs/react-doctor-migration-2026-06-15.md`.

Invariants (do not regress without updating this section, `doctor.config.ts`, and the doc):
- **Telemetry OFF.** `noScore` + `share:false` in config; `REACT_DOCTOR_NO_TELEMETRY=1` in the
  workflow `env` (the Action exposes no flag). Nothing is sent to the hosted score API / Sentry.
- **Gate = `scope: changed` + `blocking: error`.** Only NEWLY introduced error-severity issues
  fail a PR; the pre-existing backlog is advisory and is burned down in stacked PRs.
- **knip is retained, NOT replaced.** `deslop` is not knip: it reads knip's `entry`/`ignore`
  (only from strict-JSON `knip.json` or `package.json#knip`, never `knip.jsonc`) but ignores
  knip's `ignoreDependencies` and has no per-dependency allowlist. So `deslop/unused-dependency`
  + `deslop/unused-dev-dependency` are disabled in `doctor.config.ts`, and `pnpm knip`
  (driven by `knip.jsonc`, with the curated false-positive allowlist) stays the dependency auditor.
- **Never set `ignore.files`** (verified against 0.5.5, re-verified against 0.7.1). A non-empty `ignore.files` flips
  the lint pass to an explicit include-list and silently drops ~half the monorepo's real
  source from linting (e.g. packages/hooks 34 → 0). Build artifacts are gitignored (never
  listed) and test-file noise is handled natively (`test-noise`-tagged rules auto-suppress
  in non-production files). Suppress findings via `ignore.overrides` / `rules`, not files.
- **`Accessibility` + `Security` categories are OFF.** a11y is already enforced by the
  biome a11y rules (and react-doctor can't read `biome-ignore`, so it re-flagged every
  documented exception + custom ARIA widget — an audit of 28 findings found 1 genuine
  gap). Security produced 0 genuine issues across 6 real-source findings; secret detection
  stays covered by the lefthook `secrets-scan`. react-doctor's unique value here is its
  React-Compiler-correctness rules (`react-hooks-js/*`, `react-compiler-*`) + dead-code,
  which is where remediation effort is focused.
- **`react-compiler-no-manual-memoization` is OFF.** Manual `useMemo`/`useCallback`/
  `React.memo` is intentional here (guards non-React work, external-store identity,
  referential stability for consumers outside the compiled tree). The rule fired 1211× (54%
  of the original backlog) demanding removal — disabled per team decision.
  `react-hooks-js/preserve-manual-memoization` stays ON (it protects memo the compiler needs).

Local: `pnpm doctor` (full scan, telemetry off via config) ·
`npx react-doctor . --scope changed --verbose` (only new issues) ·
`npx react-doctor why <file>:<line>` (explain a rule).

---

## EMBEDDING ARCHITECTURE (CRITICAL)

Renderer-only execution is mandatory.

Rules:
- Embedding worker MUST run in renderer (browser context).
- MUST NOT run in Electron main process.

Reasons:
- Transformers.js requires Web Workers (renderer only).
- In main/Node, it degrades to synchronous WASM → freezes UI.

Flow:
1. Hidden host renderer
   - Files:
     - apps/desktop/src/embedding-host-manager.ts
     - apps/desktop/src/renderer/components/embedding-host-app.tsx
     - apps/desktop/src/renderer/components/embedding-host-runtime.tsx
   - Main creates a hidden BrowserWindow with `?mode=embedding-host`.
   - The host renderer mounts `DbProvider` with `useElectronIPC=true`.
   - The host renderer uses `startEmbeddingWorker()` from `@brainstrike/embeddings`.
   - It pulls jobs from the PGlite-backed `job_queue`.
   - Local models still execute in browser/Web Worker context only.
2. Visible renderer
   - File: packages/vector-management/src/vector-status/use-embedding-worker-controls.ts
   - Does NOT start the embedding worker directly in desktop mode.
   - Talks to the hidden host over the preload bridge (`window.embeddingHost`).
   - Keeps UI controls/status in sync with host lifecycle.
3. Main
   - File: apps/desktop/src/main.ts
   - Does NOT run embeddings in-process.
   - Owns host-window lifecycle, IPC, DB init, and power lifecycle.
   - Visible window uses default background throttling; only the hidden host disables throttling.
   - `powerSaveBlocker` is allowed only while the hidden host reports active embedding work.
4. Job Queue
   - File: packages/db/src/queue/job-queue.ts
   - Backed by job_queue table.
   - Lease-based locking, retries, dedupe, failure tracking.

Foreground query coordination (desktop):
- The hidden host runs BOTH background indexing and assistant query embeddings; a
  foreground query must never share the GPU with background indexing.
- `createForegroundEmbeddingGate()` (packages/embeddings/src/worker/foreground-embedding-gate.ts),
  exposed via `@brainstrike/embeddings/worker`:
  - The worker's `waitForBackgroundPermit('embedding claim')` awaits the gate, so no NEW
    indexing batch starts while a query is in flight. Only the *claim* permit is gated
    (never completion) — this keeps draining deadlock-free.
  - The query handler drains the in-flight batch via `waitForWorkerIdle` (waits for the
    worker `active` flag, which is true only during inference) before generating, via
    `runCoordinatedQueryEmbedding`.
- Wiring: `embedding-worker-config.ts` (`composeClaimPermit`) +
  `embedding-host-runtime.tsx` (gate per runtime, threaded to the worker config + query
  handler). Constants: FOREGROUND_GATE_REOPEN_MS (250), QUERY_DRAIN_TIMEOUT_MS (5000).

Environment variables:
- VITE_EMBED_CONCURRENCY (default 1)
- VITE_EMBED_LEASE_MS (default 60000)
- VITE_EMBED_MODEL_KEY (e.g. local:Xenova/bge-m3, openai:text-embedding-3-small)

Do not move or reintroduce workers in Electron main. Desktop local embeddings must stay in the hidden renderer host.

---

## PROMPT WORKBENCH

The prompt library is a working surface inside the agent sidebar, not a standalone route:
Threads → Database → Prompts. Its source of truth is PGlite; never reintroduce a
localStorage-backed parallel store.

Ownership and flow:
- Persistence: migration 051 (`prompt_embedding_profiles`, `prompt_items`,
  `prompt_item_revisions`) + `PromptItemRepository`. Prompt edits use revision CAS and
  retain the previous revision. PGlite is the only prompt store; there is no localStorage
  compatibility path. Bootstrap performs the authoritative initial repository `list()`, and
  that database read remains fatal if it fails. Text filters treat SQL LIKE metacharacters
  (`%`, `_`, and `\`) as literals.
- Recall: prompt records own vectors under the dedicated singleton prompt profile — they
  are NOT fake files and MUST NOT be added to `embedding_sets`. Saved items use document
  embeddings; live composer context uses query embeddings. Vector failures surface in the
  workbench; there is no lexical fallback. Similarity search currently supports only cosine
  distance and fails closed when the configured profile declares `l2` or `ip`. The app-specific
  embedding queue loader MUST resolve before either operation so desktop/web worker URLs are
  registered explicitly.
  Indexing passes are serialized; overlapping bootstrap/save passes must never write the
  same revision concurrently. Connected refreshes remain authoritative and the interaction
  layer reconciles them into its local working set. Async save/list completions must merge
  against the latest committed authoritative snapshot, never the render that started them.
  Contextual query recall is enabled only while both the outer Explorer route and inner
  Prompts tab are visible; the force-mounted panel preserves UI state but must never run
  embedding inference while hidden. Search-embedder transitions serialize disposal and
  distinct-identity initialization (same-identity calls still deduplicate); WebGPU
  initialization/recovery fails closed while the document is hidden, and a hide event
  invalidates recovery even when it is awaiting disposal.
- Agent actions: `assistant-composer-command-store.ts` is a thread-keyed, in-memory FIFO.
  `AssistantUiPanelWrapper` bridges only that thread's head command into the real
  assistant-ui composer and acknowledges it after application. The store is registered with
  factory reset so queued commands and mirrored draft text never survive a live reset.
  Snippets/fragments append, prompts replace, and nothing auto-sends. Direct actions use a
  synchronous item/action in-flight guard so repeated activation cannot stage twice or create
  duplicate threads; prepared template submissions use the same guard and share the in-flight
  operation. Runnable prompts apply their configured model only after the model is
  enabled and its provider is available; unavailable targets fail
  visibly before mutating a thread. Their standard Mastra call settings are strictly validated
  and applied with `maxTokens` normalized to `maxOutputTokens`; unknown settings or conflicting
  aliases fail before mutation. On a provider switch, configured target-provider settings fill
  any missing per-thread target settings and build the target options; entries/options for the old
  provider remain available, but old-provider model settings must not leak into the new provider.
  On a same-provider change, explicit per-thread model settings win over provider defaults, and
  explicit settings stored on the prompt win over both.
  Workbench edits preserve stored rating and model settings until dedicated controls expose an
  explicit way to change them; changing the structured model key must not erase legacy settings.
  Rendered prompt text must be validated as non-whitespace before runtime selection, thread
  creation, composer staging, or usage writes. Composer context mirrors assistant-ui's authoritative
  state, including programmatic send/reset clears; never derive it only from textarea DOM events.
  New-thread actions create the durable thread with its final title atomically before
  activation/staging and wait for any in-flight initial resource load before creating. A ready
  thread resource must not be redundantly reloaded during this sequence or a stale `New Thread`
  snapshot can overwrite the title.
  Once persistence or composer staging succeeds, later indexing, list-refresh, or usage-count
  failures are secondary warnings: surface them explicitly, but never reject the completed
  primary action and invite a duplicate save/stage retry.
  Factory reset may tolerate only an explicitly missing legacy `prompt_items` relation. Any other
  prompt deletion failure aborts before close/VACUUM, restores reset retryability, and remains
  visible to the caller; never report a successful reset while prompt rows may remain.
- Composition: `connected-prompt-manager.tsx` owns DB/model/thread/vector wiring;
  `prompt-workbench-panel.tsx` remains the interaction layer; `prompt-template.ts` owns
  explicit `{{variable}}` resolution. The interaction layer must render a stored unavailable
  model as an explicit disabled selection (never visually pretend the current-thread model is
  selected), keep keyboard focus visible, and announce modal async failures locally. Root layout
  must load the connected manager through `connected-prompt-manager-lazy.tsx`; never pull the
  prompt/database/vector graph back into the initial app-shell bundle.

When changing this flow, update this section and the paired tests in `packages/db`,
`packages/app-shell`, `packages/ui`, and `packages/vector-management`.

---

## AI ASSISTANT INTEGRATION

- Supports: OpenAI, Anthropic, Google, OpenRouter.
- Built-in local provider:
  - Desktop/web local inference targets `onnx-community/gemma-4-E2B-it-ONNX` only.
  - No silent fallback to WASM. If WebGPU is unavailable, the built-in local provider is unavailable.
  - DESKTOP runs local chat through the assistant server's real Mastra loop
    (persistence, run events, tool guards); inference is proxied to the hidden
    llm-host. The built-in local model is also selectable as the observational
    memory model and local embedders as the semantic recall embedder — all
    keyless. See LOCAL LLM ARCHITECTURE.
- API keys:
  - Managed via Settings.
  - Desktop: encrypted keychain.
- Config:
  - packages/agent/src/providers/registry.ts
  - packages/agent/src/providers/key-resolver.ts
  - packages/agent/src/providers/provider-factory.ts
- State:
  - packages/preferences/src/stores/assistant-preferences-store.ts
  - packages/app-shell/src/assistant-thread-store.ts
  - Assistant preferences persist the most recently selected model as the default for the next
    new thread. The thread store persists each existing thread's model and provider settings so
    switching chats or restarting the app restores that thread-specific runtime.

Assistant status endpoint resolution (in order):
1. window.assistant.getUrl()  (async)
2. window.assistant.url       (static)
3. /api/assistant/status      (fallback)

Implementation:
- packages/app-shell/src/hooks/use-assistant-availability.ts

When changing this flow, update this doc.

---

## MCP TRANSPORT SELECTION (CRITICAL)

Every MCP server chooses its transport explicitly. The authoritative config
discriminator is one of `stdio`, `streamable-http`, or legacy `sse`; it is never
omitted, inferred from a URL path, or changed after a failed connection.

Remote transport rules:
- `streamable-http` is the modern MCP transport and normally targets one `/mcp`
  endpoint. It constructs only the official SDK's
  `StreamableHTTPClientTransport`.
- `sse` is the deprecated HTTP+SSE compatibility transport. It constructs only
  `SSEClientTransport`, even when its URL ends in `/mcp`.
- There is NO automatic Streamable HTTP → SSE fallback. The MCP specification
  describes that fallback as an OPTIONAL compatibility strategy for ambiguous
  URLs; Brainstrike removes the ambiguity by requiring the user to select the
  transport. A 400/404/405 initialization failure therefore remains visible.
- Both HTTP variants share strict HTTP(S)-URL, no-embedded-credentials, header,
  secret-decryption, cancellation, progress, and lifecycle behavior.

Ownership and flow:
1. Config — `apps/desktop/src/mcp-loader.ts` is the strict JSONC/Zod desktop
   boundary; `packages/agent/src/mcp/config.ts` is the serializable agent
   contract. Public renderer status exposes only server name + transport.
2. Official client — `packages/agent/src/mcp/explicit-http-client.ts`, exported
   only from `@brainstrike/agent/mcp-client`, owns the SDK 1.29 HTTP transports,
   lazy/concurrency-safe connection, header composition, request forwarding,
   session termination, and idempotent close. Keep the SDK package external in
   the agent build; do not pull this edge into browser-safe/root exports.
3. Desktop — `apps/desktop/src/mcp/http-client.ts` adapts that shared client to
   the desktop `McpClient` discovery/call contract. `sse-client.ts` is only a
   compatibility factory delegating to the canonical adapter; no bespoke SSE
   framing, endpoint rewriting, or environment-selected call path remains.
4. Agent runtime — `packages/agent/src/mastra/mcp-runtime-client.ts` partitions
   servers. Mastra `MCPClient` handles `stdio` ONLY; explicit HTTP clients are
   converted into Mastra tools and combined through the existing pipeline:
   discovery → namespace/sanitize → output bound → guard → hooks → permission.
   Remote progress uses the distinct transient
   `brainstrike.mcp-progress.chunk` `writer.custom` part and maps back to a
   `tool-event`; progress-channel failure is warning-only and never replaces a
   completed tool result or the remote tool's primary error.

Primary references:
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/client.md

When changing this flow, update this section and the focused agent + desktop
real-protocol integration tests.

---

## ASSISTANT RESILIENCE (CRITICAL)

The assistant tool→stream chain must never freeze the thread. The renderer safety
net, the two server-side resilience layers, and the Mastra error-processor layer
below are LIVE.

1. **Renderer safety net (LIVE)** — `packages/ui/src/assistant-ui-panel/assistant-panel-error-boundary.tsx`
   wraps `ChatThreadUI` (inside `AssistantRuntimeProvider`, so reset preserves
   the runtime). The data-stream adapter surfaces transport errors via `onError`
   and rethrow (never swallows). A run rejected BEFORE any stream part (e.g.
   memory-construction failure → HTTP 502) has zero message parts;
   `AssistantMessage` mounts `AssistantMessageError` (ErrorPrimitive) so that
   rejection renders as a visible error block — styling lives on the
   error-conditional `Message`, never on the always-rendered `Root` (a styled
   Root paints an empty red bar under every assistant message).

2. **Per-tool guard (LIVE)** —
   `packages/agent/src/tools/guard-tool-execution.ts`. `applyToolGuards` wraps
   the combined Mastra tool map in `createMastraAgentRuntime` after local and MCP
   tools are sanitized/discovered. Tool timeouts and throws resolve to structured
   `GuardedToolError` payloads; guarded timeout/failure payloads are surfaced as
   failed tool events, not successful completions.

3. **Stream inactivity watchdog (LIVE)** —
   `packages/agent/src/stream/with-inactivity-timeout.ts` (`withInactivityTimeout`,
   `StreamStalledError`). `streamChunksFromMastra` wraps the raw Mastra iterator.
   A stream stall emits a visible assistant message, a terminal `run.failed`
   event, and an error finish so the renderer does not remain in-flight forever.

4. **Mastra error-processor layer (LIVE)** —
   `packages/agent/src/mastra/error-processors.ts`, wired into `new Agent` +
   `buildToolLoopOptions` in `agent-runtime.ts`. Adopts three `@mastra/core`
   built-ins that recover on EMITTED provider/API errors — disjoint from the
   guard (tool-execute failures) and watchdog (silent stalls), so no
   double-wrapping:
   - **StreamErrorRetryProcessor** — retries transient mid-stream errors
     (OpenAI Responses `error`/`response.failed`, provider `isRetryable`, and an
     `isEconnResetStreamError` matcher with capped exponential backoff).
   - **PrefillErrorHandler** — recovers reloaded-thread assistant-prefill
     rejections (Anthropic / Qwen `enable_thinking`).
   - **ProviderHistoryCompat** — cross-provider `mastra_messages` reuse.
   Placement (verified against the compiled loop, do NOT relitigate): the two
   `processAPIError`-only processors + ProviderHistoryCompat's REACTIVE rules go
   on the Agent-config `errorProcessors` seam (never clobbered by the per-call
   TokenLimiter). ProviderHistoryCompat's PREEMPTIVE `processLLMRequest` rules
   (strip foreign reasoning — the ONLY place that incompatibility is handled)
   fire ONLY from `inputProcessors`, so a SECOND ProviderHistoryCompat instance
   is composed into the per-call `inputProcessors` array ALONGSIDE the
   TokenLimiter in `buildToolLoopOptions` (composing, not clobbering — their
   hooks are disjoint stages). **`maxProcessorRetries` MUST stay pinned**
   (`ASSISTANT_MAX_PROCESSOR_RETRIES = 3`): any `errorProcessors` flips Mastra's
   implicit default to 10. The whole layer is EXCLUDED for the built-in local
   provider (the hidden llm-host owns its own engine-fault recovery; no
   hosted-provider wire quirks apply).

> **LIVE validation requirement:** A prior attempt wired the guard + watchdog into
> the live path and BROKE real Mastra tool calling (hosted-provider tools silently
> stopped executing) while mocked tests stayed green. Future changes to these
> layers MUST preserve coverage that runs the actual Mastra agent loop end to end
> with real tool `execute`, not only mocked stream parts. The current proofs live
> in `packages/agent/src/__tests__/mastra-tool-execution.spec.ts` and
> `mastra-error-processors.spec.ts` (retry, prefill recovery, TokenLimiter
> clobber-guard regression, pinned `maxProcessorRetries`, bounded-terminal).

Config (strict parse — malformed value THROWS, per the no-silent-fallbacks rule),
defined in `packages/agent/src/config/resilience-config.ts`:
- `BRAINSTRIKE_TOOL_TIMEOUT_MS` (default 60000) applies to every native and MCP tool execution.
- `BRAINSTRIKE_STREAM_INACTIVITY_MS` (default 120000)
- Invariant: tool timeout < stream inactivity.
- `BRAINSTRIKE_APPROVAL_STALE_MS` (default 86400000 = 24h) — advisory age after
  which a REDISCOVERED suspended approval is flagged `stale` in the re-surfaced
  notice (see PERMISSION ENGINE §restart-safe rediscovery). Deliberately
  DECOUPLED from the two timeouts above: a human approval may legitimately take
  hours after a restart, so it is NOT tied to the in-flight stream/tool windows.
  Advisory only — both buttons stay enabled, never an auto-decline.

Stream part continuity: run-event data parts ('aui-data') CLOSE the active
text/reasoning append in assistant-stream's accumulator, slicing visible text
into fragments. `DataStreamMapper` therefore defers run events that arrive
while a text/reasoning part is streaming and flushes them at the next boundary
(tool start, approval, finish, error, stream end) — never drop them, never
emit them mid-part (proof: data-stream-text-continuity.spec.ts).

Live shell output (executeCommand streaming): `executeCommand` streams its
subprocess stdout/stderr incrementally through Mastra's tool `writer` as it is
produced (a long build/test run is visible live, not only on exit). The tool
writes via `writer.custom({ type: SHELL_OUTPUT_STREAM_PART_TYPE, … })`
(`packages/agent/src/mastra/shell-output-stream.ts`), which places the slice on
the fullStream VERBATIM — deliberately NOT `writer.write` (that wraps it as a
`tool-output` part, colliding with subagent delegation and masquerading as a
successful tool result). `processMastraStreamPart` maps that part to a dedicated
transient `shell-output` StreamChunk; `DataStreamMapper.handleShellOutput` emits
it as a `SHELL_OUTPUT_DATA_NAME` aui-data part (subject to the SAME text-part
deferral). It is NOT a run-event kind ON PURPOSE: run-events are persisted
server-side into `assistant_run_events` (and their metadata is redaction-
sanitized, which strips `output`/`text` keys) — a `shell-output` StreamChunk is
ignored by that persistence tap (`chunk.type !== 'run-event'`), so live slices
are TRANSIENT (never persisted; absent on reload — the FINAL captured output
persists as the tool result). A COMBINED streaming cap
(`MAX_STREAMED_OUTPUT_BYTES`, separate from the 1 MB capture cap) stops a runaway
process flooding the stream: at the cap one truncation notice is emitted,
streaming stops, and teardown/capture continue unchanged. Mastra hands a plain
tool OBJECT the raw `outputWriter` fn + top-level `toolCallId` (a `createTool`
instance gets `writer.custom` + `agent.toolCallId`); the desktop wiring accepts
both. The renderer accumulates slices per toolCallId
(`collectShellOutputs` + `ShellOutputProvider`) into the live tool card
(`LiveShellOutputPane`, shown only while running). background:true (run the tool
as a Mastra background task) is a documented FOLLOW-UP, not in v1. Proofs:
mastra-tool-execution.spec ('streams incremental shell-output …'),
execute-command-tool.test / execute-command-live-loop.test, shell-output-parts.test.

Parallel tool calls: Mastra executes tool calls within a step concurrently
(default concurrency 10; `toolCallConcurrency` loop option). Mastra forces
sequential execution when the run-wide `requireToolApproval` is set OR any active
tool carries the per-tool `requireApproval` flag / a suspend schema. The
permission engine (see PERMISSION ENGINE below) marks `'ask'` tools with the
PER-TOOL `requireApproval`, so a run that includes any ask tool executes its step
sequentially (the price of the per-tool gate), but only the ask tool actually
suspends — allowed tools still run. A run with no ask tools stays parallel. The
approval-resume path sets the run-wide `requireToolApproval`. The data-stream
mapper and UI key all per-call state by toolCallId and handle interleaving.

When changing this flow, update this section and the related tests.

---

## PERMISSION ENGINE (TOOL APPROVAL)

Mutation tools PROMPT for per-call approval by default. The permission policy
store (`packages/preferences/src/stores/permission-policy-store.ts`) defaults to
`enforce: true` with policies `{read:allow, mcp:allow, edit:ask, execute:ask}`,
so by default read/MCP tools run free while edits and shell commands suspend the
run for user approval. A user can turn `enforce` off (explicit opt-out), set a
category to `allow`/YOLO, or grant a session category.

Flow (desktop assistant server → agent runtime):
1. The renderer attaches the persisted policy snapshot to the request only when
   `enforce` is true. `resolveRequestPermissionPolicy` (agent) builds the trusted
   `PermissionToolGateSnapshot` with a SERVER-built `riskByTool`
   (`buildNativeToolRiskMap`) — the client never classifies tool risk.
2. `filterToolsByPermissionWithMetadata` (`packages/agent/src/mastra/permission-tool-gate.ts`)
   gates the tool map BEFORE the immutable `Agent` is built: `'deny'`→omit;
   `'allow'`→keep unchanged; `'ask'`→keep a CLONE with Mastra's PER-TOOL
   `requireApproval: true` and record in `askToolIds`.
3. PER-TOOL, not global: marking each ask tool with `requireApproval` (Mastra
   >=1.37) makes Mastra suspend ONLY when that tool is actually called — allowed
   `read`/`mcp` tools in the same run still run free. We deliberately do NOT force
   the run-wide `requireToolApproval` (it would suspend EVERY tool call, breaking
   the read-only default). `createMastraAgentRuntime`'s `resolveAskToolsForRun`
   only decides whether ask tools may STAY: WITH Mastra workflow storage they stay
   (their per-tool flag suspends + the resume path can restore the run); WITHOUT
   storage (`streamMastraToolApprovalAction` throws) they are fail-safe OMITTED
   (never run an approval-required tool unprompted — no-silent-fallbacks).
4. The approval UI + resume chain (`makeApprovalRequiredChunks` →
   `tool-approval-required` chunk → `DataStreamMapper.handleToolApprovalRequired`
   → `TOOL_APPROVAL_DATA_NAME` data part → `assistant-tool-approval-notice.tsx`)
   prompts the user; approve→execute, decline→skip. The chunk carries an optional
   `riskCategory`/`policyDecision` so the notice can name the reason. The
   approve/decline resume (`streamMastraToolApprovalAction`) passes
   `requireToolApproval: true` (the resume API needs it); the gate runs again on
   resume so the ask tools keep their per-tool flag. Because run-wide
   `requireToolApproval: true` would suspend EVERY tool call on the resumed leg —
   including Mastra's INTERNAL memory tools (`updateWorkingMemory`) —
   `resolveResumeApprovalGate` (agent-runtime.ts) substitutes the FUNCTION form of
   the gate, exempting the canonical internal ids
   (`internal-approval-exempt-tools.ts`: `updateWorkingMemory`/`setWorkingMemory`)
   so memory bookkeeping never prompts while genuine mutation tools still suspend.

Migration (enforce-on is a SECURITY fix): the store bumps to v2. Under v1,
`false` was the default AND always persisted, so a pre-v2 `false` slice is
indistinguishable from an opt-out — `migrate` adopts the secure default (`true`)
for ANY pre-v2 slice (a genuine v1 opt-out gets re-prompted once, the safe
direction). Only a v2+ persisted boolean is honored verbatim. Skipping this would
leave upgrading `enforce:false` users with the now-always-registered, ungated
`executeCommand` — the regression this guards against.

Web: the in-renderer LocalRuntimeChat never reaches `streamMastraAgent` (no
assistant server / storage), so ask tools are fail-safe-omitted there and web
local chat is unaffected (desktop-first).

Live-loop proof (real Agent + real PGlite workflow storage, no agent mock):
`packages/agent/src/__tests__/mastra-tool-approval-suspend.spec.ts` —
suspend→approve→execute, suspend→decline→skip, AND an allowed read tool runs
FREE while an ask tool is in the map (the per-tool-not-global guard). NOTE: the
scripted model's synchronous stream starves the event loop during the
PGlite-backed resume; the test drains with a per-chunk `setImmediate` yield
(mirrors real streaming) — a harness concern, not a production bug.

Restart-safe rediscovery (a run suspended for approval survives a desktop
restart / renderer reload, but the LIVE approval notice — a never-persisted
stream data part — is gone on reload): on thread open the desktop history
adapter rediscovers pending approvals and re-surfaces a working notice, REUSING
the (already restart-safe) `streamMastraToolApprovalAction` resume seam
untouched. Flow:
- `listSuspendedMastraRuns(filter, options)` (`agent-runtime.ts`) wraps
  `agent.listSuspendedRuns` — rebuilds a FRESH runtime (no in-memory handle),
  returns approval-gated tool calls only (`requiresApproval === true`);
  non-approval `suspend()` pauses (submitPlan/askUser) and delegation-thread runs
  are tolerated + skipped (debug-logged) — a unified suspend rediscovery is a
  follow-up. Discovery is CONTEXT-FREE + KEYLESS: the stable agent id
  (`brainstrike-assistant`) is provider-independent, so listing constructs a
  keyless `ollama` agent (no provider/apiKey from the renderer, no inference).
- Desktop route `GET /assistant/suspended-runs?threadId=&resourceId=`
  (`apps/desktop/src/assistant-server.ts`): recomputes `riskCategory` from
  `buildNativeToolRiskMap()` and stamps `stale` against
  `BRAINSTRIKE_APPROVAL_STALE_MS`. Missing thread ctx → 400; no storage → 503.
- Renderer client `createSuspendedApprovalDiscovery` (app-shell,
  desktop-capability-gated — web omits it, no `isElectron()`) → hydration
  injection `appendSuspendedApprovalMessages` appends one synthetic trailing
  assistant message per approval carrying a `TOOL_APPROVAL_DATA_NAME` data part
  identical to the live mapper's output; the existing notice + its
  Approve/Decline resume render unchanged. Staleness is display-only (D5): a
  muted "Pending since <relative>" line always, an amber advisory when `stale`,
  both buttons enabled, NO auto-decline.
- Restart proof extends the same spec: a run suspended under `openai` is
  rediscovered by a keyless `ollama` listing over the same PGlite DB and resumed
  to execution by a THIRD fresh runtime.

When changing this flow, update this section and the related tests.

NOTE: the per-tool approval gate is SEPARATE from tool SUSPENSION (submitPlan /
askUser) — see PLAN MODE & TOOL SUSPENSION below. Approval pauses BEFORE a tool
runs (`tool-call-approval` → `approveToolCall`/`declineToolCall`); suspension
pauses DURING a tool's `execute` via `suspend()` (`tool-call-suspended` →
`resumeStream`). submitPlan/askUser are classified `riskCategory:'read'` so the
permission engine never stacks an approval prompt on top of their own suspend.

---

## TOOL-LIFECYCLE HOOKS (Claude-Code-style)

User-authored shell commands that run at lifecycle events and (for blocking
events) can refuse to proceed. **Desktop-only by construction** — shell hooks
need Node `child_process` + absolute root paths + the assistant server; web
constructs NO hook runner (capability-gated, no `isElectron()` checks).

Seven events, three blocking (`PreToolUse`, `Stop`, `UserPromptSubmit`). A hook
is `{ type:'command', command, matcher?:{tool_name}, timeout?, description? }`.
It receives a JSON payload on **stdin** (secret-redacted), returns optional JSON
on **stdout** (`{decision, reason, additionalContext}`); its **exit code** is
authoritative: `2` = hard block on a blocking event, other non-zero =
warn-and-continue, `0` = ok. Per-hook timeout → **SIGKILL**.

**Insertion points (do not move):**
- `PreToolUse`/`PostToolUse` live in the tool-execute seam. `applyToolHooks`
  (`packages/agent/src/tools/hook-tool-wrap.ts`) is a SIBLING of `applyToolGuards`,
  composed OUTSIDE the guard, BEFORE the permission gate:
  `combinedTools → applyToolGuards → applyToolHooks → plan-mode → permission gate`
  (`agent-runtime.ts`). Permission runs downstream of `execute`, so **hooks
  REFINE, never widen**: a PreToolUse hook can BLOCK a permitted tool but can
  never allow a denied/ask tool. A block returns a `HookBlockedToolError`
  (`error.code:'tool_blocked_by_hook'`, recognized by `isGuardedToolError`) so it
  renders as a FAILED tool event. PostToolUse `additionalContext` is capped
  (`HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET` 2000) and merged into the tool result.
  A hook-runner FAULT is allow-on-fault (a runner bug must not brick tool calling).
- `UserPromptSubmit`/`Stop` run in `apps/desktop/src/assistant-server.ts`
  (`initializeAgentStream`). A UserPromptSubmit block short-circuits the turn with
  a visible message + `run.failed` and NEVER invokes the model; additionalContext
  prepends a `system` message. The blocked branch returns an `ok:true` stream but
  carries `terminalStatus:'failed'` (+ `terminalError`) on `AgentStreamSuccess`, so
  `streamAssistantPostResponse` persists the `thread_runs` row as `failed` — never
  the default `completed`, which would contradict the visible `run.failed`.
  **Stop is NOTIFY-ONLY in v1** (surface the block reason as a `hook.notice`; NO
  auto-continue). The terminal Stop hook (`withStopHook`) MUST run BEFORE the
  `message-finish` chunk is yielded, not only in its `finally`: the live
  data-stream consumer stops pulling the source the instant the mapper emits
  `finish`, so a `hook.notice`/`hook.blocked` queued AFTER the finish reaches
  neither the live renderer nor persistence. Running Stop at the finish boundary
  lets the observer drain those queued run events (the mapper defers them past an
  open text part and flushes at the boundary); `finally` still fires Stop for
  streams that end without a finish chunk (bare return / throw / abort).
  SessionStart/SessionEnd/Notification are implemented but UNWIRED in v1.

**Timeout invariant (honest ceiling — no summed guarantee).** There is NO
enforced `pre + tool + post` sum ceiling. What IS enforced:
- **Per-hook:** `config.ts` rejects any hook whose `timeout >=
  resolveToolTimeoutMs()`; every hook is SIGKILLed at its own timeout (default
  10_000ms). Chain: `per-hook (<60s) < BRAINSTRIKE_TOOL_TIMEOUT_MS (60_000) <
  BRAINSTRIKE_STREAM_INACTIVITY_MS (120_000)`.
- **Watchdog-covered in-stream phases** (`PreToolUse`/`PostToolUse`): bounded by
  the per-hook SIGKILL + the stream inactivity watchdog (120s) as the backstop —
  NOT by an aggregate cap. These run WHILE an `iterator.next()` is pending, so the
  watchdog timer is armed and covers them.
- **Boundary phases the watchdog CANNOT reach** (`UserPromptSubmit` + `Stop`):
  both gate a user-visible boundary with the watchdog disarmed, so each carries
  its OWN aggregate bound (`resolveToolTimeoutMs()`, 60s), applied at runtime by
  `runHooksForEvent` (`aggregateTimeoutMs`, threaded via the manager's
  `aggregateTimeoutMs` ctx): the in-flight hook is SIGKILLed at the remaining
  budget and the rest are skipped with a loud warning (timeout ==
  warn-and-continue; hooks proceed, never silently stall turn start / finish
  delivery).
  - `UserPromptSubmit` runs BEFORE the model is invoked; it ALSO enforces the
    bound on the config-load end: `loadHooksConfig` disables the phase fail-LOUD
    (a `HookConfigError`) when the combined declared timeout reaches the ceiling.
    Over-budget config never silently truncates.
  - `Stop` runs in FRONT of the `message-finish` yield (the watchdog is applied
    UPSTREAM of the `withStopHook` seam and its timer is disarmed while Stop
    awaits), so an unbounded chain of Stop hooks would delay finish delivery, the
    Stop notices, HTTP stream close, and the `thread_runs` status write. The
    runtime aggregate cap is its only bound — the watchdog does NOT cover it.
    (v1 has no config-load check for the Stop combined timeout; the runtime cap
    is authoritative.)

**Malformed config = disable-with-visible-error (NOT throw-at-load).**
`loadHooksConfig` returns `{hooks, errors, sources}`; a malformed/untrusted file
contributes ZERO hooks (fail-CLOSED) AND records a `HookConfigError` surfaced on
THREE channels (`logger.error`, a `hook.notice(failed)` run event via
`reportConfigErrors`, the Hooks settings banner). Never throw at load — that
would brick every run over a config typo and hand a malicious repo a DoS. This is
loud + fail-closed, the opposite of a silent fallback.

**Security spine (trust gate).** Global hooks (`~/.brainstrike/hooks.json`, the
user's own machine) run without approval. **Project** hooks
(`<root>/.brainstrike/hooks.json`, per mounted desktop root) run ONLY after a
per-root approval **pinned to the file's SHA-256**. The trust store
(`packages/preferences/src/stores/hook-trust-store.ts`, persisted,
factory-reset-registered) records `{rootId → {approvedSha256, approvedAt}}`. The
renderer only ATTESTS approved hashes over the wire (`HookTrustRequest`); the
server independently RE-READS + RE-HASHES disk (`trust.ts` `resolveTrustedRoots`)
and runs a root's hooks only when `sha256(disk) === approvedSha256`. The trust
hash is over the RAW file BYTES (`sha256OfBuffer`), and the approve-time review
(`ipc-hooks-handlers.ts`) hashes those same bytes — never a utf8-decoded string,
which would diverge for BOM/non-utf8 bytes and silently void an approval. Trust
+ parse come from ONE read (`loadHooksConfig` reads the bytes once, hashes them,
and parses those same bytes only when trusted — no read-vs-hash TOCTOU window). A
changed file → untrusted (re-approve). Keyed by durable `rootId`, never raw path.
Stdin payloads are secret-redacted before spawn (`executor.ts` `redactSecrets`,
mirrors the logger redact key set). NOTE: redaction covers ONLY the stdin JSON —
it does NOT extend to the hook's inherited `process.env` (hooks inherit the full
assistant-server env). Low-risk here: provider API keys live in the encrypted
keychain, never in the process env.

**Config paths (D6):** global `~/.brainstrike/hooks.json` (new home-dotfile, for
discoverability); per-root `<root>/.brainstrike/hooks.json`. Merge order:
global-first, then roots in mounted order; each loaded hook is tagged with its
source `cwd`/`rootId` (global hooks' cwd = primary root).

**Threading:** `RuntimeData.hookRunner` (trusted, agent-only, never serialized —
mirrors `localLlmHostClient`; preserved by `resolveRuntimeConfiguration`'s spread)
+ `RuntimeData.hookTrustRequest` (wire). The server STRIPS any client-supplied
`hookRunner` and injects the server-built one (closure over `HookManager`).

**Run-event kinds:** `hook.blocked`, `hook.notice` (in `ASSISTANT_RUN_EVENT_KINDS`).

**Settings + review IPC:** `hooks-settings-section.tsx` (per-root
trusted/untrusted/changed/parse-error + approve/revoke) via
`hooks:getProjectHooksForReview` IPC (`ipc-hooks.ts`) + `window.hooks` preload
bridge (capability-gated). The LIVE mounted roots are threaded from the desktop
settings page (`apps/desktop/.../settings/page-content.tsx`): it reads
`activeRootIds` + `rootDescriptors` from the file-explorer zustand store (reactive
to mount/unmount, no restart) and maps them to `HookReviewRoot`
(`{rootId, absPath, displayName}`, sidebar order) for `createHooksSettingsCategory`.
Capability-gated by construction — the WEB settings page never constructs the Hooks
category, so it needs no roots. Each row's review is fetched independently; a
transport-level bridge failure for one root renders THAT row `Unavailable` (a
structured `error` review), never a stale/empty "no hooks" lie.

**Trust is keyed by the DB `roots.id`, NOT the adapter rootId (SECURITY).** The
adapter uuid is minted afresh on every `fs:addRoot` and dropped on `fs:removeRoot`,
so a remove→re-add of the SAME path yields a NEW adapter id while the DB `roots`
row persists and is path-matched by `reconcileRoots` — the two ids DIVERGE on that
ordinary flow. The server keys trust by the DB id (its roots come from the DB
`roots` table), so the panel MUST too or revoke/approve target a dead id while the
server keeps trusting a live grant (the fail-OPEN #1570 closed). Mechanism:
- The review IPC runs in MAIN (DB access): it CONTAINMENT-checks the reviewed path
  against the mounted DB roots (realpath'd — `resolveDbRootForPath`; an arbitrary
  or symlink-escaping path is refused, fixing the old "any absolute path" read) and
  returns the resolved `dbRootId`. The panel keys status/approve/revoke by THAT id.
- `buildHookTrustRequest` (hook-trust store) is SCOPED to the currently-mounted
  roots' DB ids. The assistant wrapper resolves them via
  `window.hooks.resolveTrustedRootIds(mountedPaths)` (same main DB-id seam) and
  attests NOTHING until resolved / if the resolver is absent (fail closed). A
  disconnected root's grant is therefore never presented to the server → its hooks
  fail closed even though the DB row stays `status='live'`. NOTE: the
  disconnect-severs property is RENDERER-ENFORCED (via this attestation scoping) —
  the server keys off ALL `status='live'` DB rows and nothing sets a row non-live
  on disconnect. This is sound under the app's same-process trust model plus the
  server's authoritative disk re-hash: a renderer that skips scoping can at most
  re-run byte-identical already-approved hooks, never new content.
- The store bumped to v2: pre-v2 adapter-keyed approvals are DROPPED at migration
  (unremappable without DB access → re-approval is the safe direction; mirrors the
  permission-policy v2 security bump). Factory reset clears the store unchanged.

Live-loop proofs (real Agent + real `applyToolHooks`, no stream mocks):
`packages/agent/src/__tests__/mastra-tool-execution.spec.ts` (block / allow +
PostToolUse context / runtime-threaded / no-runner regression / runner-fault).
Server composition: `apps/desktop/src/__tests__/assistant-server/hooks/`.

**Deferred (documented follow-ups):** SessionStart/SessionEnd/Notification
wiring; Stop auto-continue; Stop `assistant_message` accumulation; full hooks.json
editor UI; rendering the fetched `content` in-panel (approval is hash-only today);
a refetch on approve/revoke/refocus (a disk edit after the fetch shows a stale
badge until reopen — fail closed server-side); `<userData>` vs home-dotfile
decision.

When changing this flow, update this section and the paired tests.

---

## PLAN MODE & TOOL SUSPENSION (ask-user / submit-plan)

Two SUSPENDING native tools pause the run DURING execution and resume with
arbitrary data, on a NEW transport that PARALLELS the approval transport (it does
not overload it). Built on `@mastra/core@1.50` tool `suspend()`/`suspendSchema`/
`resumeSchema` + `agent.resumeStream(resumeData, {runId, toolCallId})`.

- **`submitPlan`** (packages/agent/src/tools/submit-plan-tool.ts): takes a
  structured plan INLINE (`{title, overview, steps[], risks?, verification?}` —
  NOT an on-disk path like Mastra's builtin `submit_plan`), `suspend()`s with it,
  and on resume returns `{status, feedback?}`. Resume vocab is the builtin-
  compatible `{action:'approved'|'rejected', feedback?}` (SubmitPlanDecision).
- **`askUser`** (ask-user-tool.ts): `{question, options?, selectionMode?}`,
  resumes with `string | string[]` (AskUserAnswer); multi-select joins with ", ".

**Transport table (parallel to approval):**

| Layer | Approval | Suspend (this feature) |
|---|---|---|
| Stream chunk | `tool-approval-required` | `tool-suspend-required` |
| Data part | `brainstrike.tool-approval` | `brainstrike.tool-suspend` |
| Run-config key | `brainstrikeToolApproval` | `brainstrikeToolSuspend` |
| Resume action | `AssistantToolApprovalAction` | `AssistantToolResumeAction` |
| Server fn | `streamMastraToolApprovalAction` | `streamMastraToolResumeAction` |
| Mastra call | `approveToolCall`/`declineToolCall` | `resumeStream(resumeData,{runId,toolCallId})` |
| UI renderer | `AssistantToolApprovalNotice` | `AssistantToolSuspendNotice` (branches by toolName) |

Contract types + guards live in `@brainstrike/assistant-contract/tool-suspend`
(`readToolResumeRunConfigAction` returns `{invalid:true}` on a malformed action —
surfaced as a 400, never coerced).

**Stream path** (agent-runtime.ts): Mastra emits `tool-call-suspended` when a
suspending tool calls `suspend()`. `makeToolSuspendRequiredChunks` turns it into
a resumable `tool-suspend-required` chunk + a tool-calls finish and STOPS at the
pause (this replaced the old `makeUnsupportedApprovalChunks` dead-end at ~936).
A malformed pause (missing toolCallId/runId) still falls back to the unsupported
termination so it fails visibly. `DataStreamMapper.handleToolSuspendRequired`
emits the `brainstrike.tool-suspend` data part, honoring the text-part deferral
contract (flush pending run events + finalize open text first). The data part is
transient (aui-data, NOT persisted) — same as approval.

**Resume** (`streamMastraToolResumeAction`): REQUIRES Mastra workflow storage
(throws without it — no silent fallback), calls `resumeStream`, threads
`withRuntimeDerivedStreamOptions` so the rebuilt Agent keeps its native tools
(the same desktop write-on-approval fix), and does NOT pass `requireToolApproval`
(that is approval-specific). Stateless: it holds no in-memory runId, so a future
`listSuspendedRuns` rehydrator can call it with a discovered runId unchanged.

**Storage fail-safe** (`resolveSuspendToolsForRun`, plan-mode-tool-gate.ts): a
tool that can `suspend()` (detected structurally by an own `suspendSchema`) is
FAIL-SAFE omitted from the map when there is no storage to resume it — mirrors
the ask-tools omit in `resolveAskToolsForRun`. Web in-renderer LocalRuntimeChat
has no server/storage, so both suspend tools are omitted there (desktop-first, v1).

**Plan mode** (opt-in, per-request `runtimeData.planMode`): a persisted composer
toggle (`assistant-preferences-store.planModeEnabled`) sends `planMode:true` only
when on (presence-means-on, gated to the desktop data-stream transport in the
app-shell wrapper). `filterToolsForPlanMode` runs BEFORE the permission gate in
`createMastraAgentRuntime`: it keeps read/mcp tools + the suspending tools and
OMITS every edit/execute tool, so the model investigates read-only and proposes a
plan before any changes. `manageTaskList` (`riskCategory:'read'`) DELIBERATELY
stays available in plan mode: it is thread bookkeeping (the assistant's own todo
list), not workspace/fs mutation, so the model can plan its steps while planning.
`buildDefaultInstructions(toolNameMap, {planMode})`
prepends a PLAN-MODE block. THREE-SIDED local gating (mirrors the task-list tool):
plan mode is EXCLUDED for provider `'local'` (the filter + the instruction block
+ the runtime `planModeActive` guard all check `normalizedProvider !== 'local'`),
and the composer toggle itself is HIDDEN for the `'local'` provider in the
app-shell wrapper (`selectedProvider !== 'local'`) rather than silently no-opping.
**Approve exits plan mode:** APPROVING a submitted plan clears the persisted
`planModeEnabled` toggle BEFORE the resume request is composed (via the
`PlanModeExitProvider` seam consumed by `AssistantToolSuspendNotice`), so the
resume omits `planMode` and the rebuilt runtime unlocks the mutation tools;
REJECT keeps plan mode on so the model can revise.

**Cross-reload hydration:** in-session resume works today; cross-reload resume
waits on the separate `listSuspendedRuns` feature (the data part is transient).
`AssistantToolResumeAction`'s fields are all recoverable from
`listSuspendedRuns().runs[].toolCalls[]`, so nothing here blocks it.

Paired tests: packages/agent/src/__tests__/mastra-tool-suspend-resume.spec.ts
(real Agent + real PGlite: suspend→approve, reject-with-feedback, askUser
free-text + multi-select, no-storage fail-safe omit + resume-throws, plan-mode
drops edit / keeps submitPlan); plan-mode-tool-gate.spec.ts; the streaming +
data-part-continuity + default-instructions plan-mode specs; the desktop
assistant-server resume-dispatch tests; and the UI suspend-notice tests.

When changing this flow, update this section and the paired tests.

---

## SUBAGENTS (PERSONA DELEGATION)

The supervisor assistant can delegate to built-in, read-only child personas
using **Mastra's native supervisor pattern**: child `Agent`s passed via the
parent's `agents: {...}` config become `agent-<key>` delegation tools
automatically. We do NOT build a bespoke `subagent` tool — we ride Mastra's
delegation machinery (hooks, memory isolation, nested-chunk forwarding,
`subAgentToolResults`) and layer brainstrike's rules on top.

- **Personas as data:** `packages/assistant-contract/src/personas.ts`
  (`BUILT_IN_PERSONAS` = `explore`, `analyze`; v1 has no user-defined personas).
  A persona names an explicit list of ORIGINAL read-only native tool ids;
  `assertReadOnlyPersona` throws at module init if any resolves to a non-`read`
  risk (unknown id ≠ read — no silent fallback).
- **Child factory:** `packages/agent/src/mastra/build-persona-subagents.ts`.
  Each child's tool map is a permission-gated SUBSET of the parent's ALREADY-
  GUARDED tool map (so per-tool timeout + `GuardedToolError` inherit for free).
  Permission composition (D3): the candidate map passes through the SAME
  `filterToolsByPermissionWithMetadata` gate as the parent, then EVERY `'ask'`
  tool is OMITTED (fail-safe — no nested approval UX in v1). An empty post-gate
  map ⇒ the persona is NOT registered. Children have **no `agents`** (no nesting)
  and **no `memory`** (Mastra injects the parent's memory and scopes writes to a
  fresh delegation thread). The child `Agent` id EQUALS the persona id — Mastra
  sets `DelegationStartContext.primitiveId = agent.id`, and the caps resolve the
  persona by that id.
- **Safety rails:** `packages/agent/src/mastra/subagent-delegation.ts`
  (`createDelegationConfig`): per-run `DelegationConfig` closure —
  `MAX_CONCURRENT_DELEGATIONS = 2`, `MAX_DELEGATIONS_PER_RUN = 8`, persona
  `maxSteps` clamp (a model-supplied `maxSteps` can never exceed the cap),
  unknown-persona rejection, and `onDelegationComplete` logs child usage (the
  parent meter does NOT aggregate child tokens in v1). Passed per-call on
  `streamOptions.delegation` in ALL THREE stream iterators — initial-turn,
  approval-resume, AND suspend-resume (`createToolResumeIteratorFromRuntime`),
  so an askUser pause→answer that then delegates keeps the caps. The closure is
  rebuilt per leg, so the per-run cap is effectively per-leg (v1 tradeoff).
  An in-flight delegation whose parent run is ABORTED mid-stream gets a terminal
  `subagent.failed` (status `cancelled`) event via
  `createDelegationLifecycleTracker` (drained on the generator's abort paths),
  so a cancelled parent never leaves an orphaned `subagent.started`.
- **Stream → run events (D9):** `processMastraStreamPart` (agent-runtime.ts)
  threads `runtime.delegationToolPersonas` (`agent-<key>` → personaId). A parent
  `tool-call`/`tool-result`/`tool-error` for a delegation tool ALSO emits
  `subagent.started`/`.finished`/`.failed` (the generic `tool.*` timeline stays
  intact). A delegation `tool-output` (nested child chunk, §Mastra ToolStream) is
  BYPASSED from the generic path and mapped to `subagent.tool.started`/
  `.completed`/`.failed` — otherwise each nested chunk would flood the UI with a
  bogus successful tool event + `toolCallResult` frame. Six run-event kinds
  (`subagent.*`) live in `run-events.ts`; the read-path `requireRunEventKind`
  throws on unknown kinds, so the contract enum MUST ship before any emitter.
  Metadata carries ids/labels ONLY (`parentToolCallId`, `personaId`,
  `toolCallId`, `toolName`) — never args/results (the sanitizer strips those).
- **Budget guard:** `subAgentToolResults` is a `TRIMMABLE_COLLECTION_KEYS` entry
  (tool-output-limits.ts) so an oversized delegation result trims structurally
  (truncated + hint) instead of a hard size error.
- **Desktop wiring:** `apps/desktop/src/assistant-server.ts` sets
  `runtime.personas = BUILT_IN_PERSONAS` unconditionally on the shared runtime
  (covers initial + both resume paths). Personas are skipped agent-side for
  `provider === 'local'` (D10 — the 2B on-device model's prompt budget) and in
  plan mode (delegation is out of scope for planning). Web is unaffected: the
  in-renderer `LocalRuntimeChat` never reaches `streamMastraAgent`.
- **Delegation-thread residue (accepted for v1):** children write to fresh
  Mastra threads under `<resourceId>-<personaId>` resource ids — invisible to the
  user's thread list (queried by the user's own resourceId). Cleanup of orphaned
  delegation threads is a follow-up (factory reset already purges the DB).
- **Live-loop proof:** `packages/agent/src/__tests__/mastra-subagent-execution.spec.ts`
  (real supervisor Agent + real child Agent + real child tool `execute`; one
  scripted model serves both levels, discriminated by `options.tools`) —
  delegation runs, child tool executes, `subagent.*` events fire in order sharing
  `parentToolCallId`, no-personas + plan-mode + local-provider skips pinned.
  Unit: `build-persona-subagents.spec.ts`, `subagent-delegation.spec.ts`.

The SubagentCard renders per-child-tool rows from BOTH the tool part's persisted
`subAgentToolResults` (authoritative on reload + at completion) AND, while the
delegation is still running, LIVE `subagent.tool.*` run events from the current
message (keyed by `parentToolCallId`); persisted rows supersede live rows by
child `toolCallId`, so a running delegation shows its in-progress tool count
instead of "Running · 0 tool calls".

Follow-ups (out of scope for v1): nested approval UX + a `subagent` policy row
(D13), persona model pinning (throws today), a preferences availability toggle,
and child input-budgeting (`messageFilter`).

When changing this flow, update this section and the paired tests.

---

## ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION

Hosted-provider turns are persisted by Mastra (the durable writer) into
`mastra_messages`; the client history adapter is read-through only. Two
contracts keep reloaded threads identical to live ones:

1. **Persisted dialect (Mastra v2 / `MastraMessageContentV2`):** content is
   `{ format: 2, parts: [...] }`. Tool calls are
   `{ type: 'tool-invocation', toolInvocation: { toolCallId, toolName, args,
   state, result } }` parts with results INLINE — there are NO `role: 'tool'`
   rows in this dialect (the legacy `tool-call` part + separate tool rows is
   still supported for old data). Reasoning may arrive with a `reasoning`
   field instead of `text` (and is often empty for encrypted provider
   reasoning). `step-start` and `data-om-*` bookkeeping parts are not
   renderable. Live-loop proof (real agent + real PGlite memory, no mocks):
   packages/agent/src/__tests__/mastra-memory-persistence.spec.ts. Hydration
   fixtures must mirror REAL persisted rows, never hand-written shapes — a
   hand-written `tool-call` fixture previously kept tests green while real
   tool history silently vanished on every reload.
2. **Snapshot grouping + live-order interleaving:** observational-memory
   sealing and per-step saves split ONE live assistant turn into several
   `mastra_messages` rows (progressive snapshots under fresh ids, so one
   toolCallId can appear in several rows). Hydration
   (packages/app-shell/src/assistant-memory-repository.ts) therefore:
   - merges consecutive assistant rows into ONE assistant-ui message (id =
     last row, createdAt = first row; legacy `role: 'tool'` rows don't split
     a group),
   - dedupes tool calls by toolCallId (first occurrence wins; later
     result/error fields merge in),
   - assigns each turn's run events to its own group by timestamp and weaves
     them between content parts in time order. Tool-invocation parts carry no
     persisted timestamp, so each is re-timed to its `tool.started` run event
     (matched via `metadata.toolCallId`); other untimed parts anchor to their
     snapshot row's save time. A group with only run events still renders.

Built-in LOCAL provider turns persist on DESKTOP: local chat routes through
the assistant server's Mastra loop (see LOCAL LLM ARCHITECTURE), so memory,
run events, and reload hydration behave exactly like hosted providers.
Known gap: WEB local turns still use the in-renderer LocalRuntimeChat (no
history adapter) and remain session-only.

When changing message persistence or hydration, update this section and the
paired tests in packages/agent and packages/app-shell.

---

## ASSISTANT RUN NOTIFICATIONS

OS-level `Notification` API alerts for three run-lifecycle events — run
finished, run failed (including watchdog stalls surfacing as `run.failed`),
and tool approval required — fired only while the app is NOT the user's
active focus. One code path for Electron renderer AND web: the standard web
`Notification` constructor, no Electron `Notification` module, no new IPC.

Layers:
1. **Preferences** (`packages/preferences/src/stores/notification-preferences-store.ts`) —
   persisted master toggle (`masterEnabled`, default OFF) + per-event toggles
   (`events.{runFinished,runFailed,toolApprovalRequired}`, default ON).
   PERSISTED via the same `createBrowserJsonStorage` pattern as sibling
   stores. Registered in the factory-reset pipeline: like
   `permission-policy-store`, `resetNotificationPreferencesStoreToDefaults`
   is called directly from `factory-reset-helpers.ts`'s `clearBrowserStorage`
   (not `registerFactoryResetSessionStore` — that seam is for stores OUTSIDE
   the `preferences` package) so the live in-memory toggle never survives a
   reset that does not reload the page (web path).
2. **Decision + dispatch** (`packages/preferences/src/notifications/`) —
   `should-notify.ts` is a PURE gate (`shouldNotify`): master on, event on,
   `Notification.permission === 'granted'`, and the window is unfocused
   (`document.visibilityState === 'hidden' || !document.hasFocus()`,
   evaluated AT EVENT TIME). `notification-permission.ts` wraps
   `Notification.permission`/`requestPermission()` — permission is requested
   ONLY from the Settings toggle-on click (never on load), and the store
   never persists `masterEnabled: true` when the browser denies or has not
   granted permission. `run-notification-dispatcher.ts`
   (`createRunNotificationDispatcher`) evaluates the gate and constructs a
   `Notification` with privacy-safe copy. Coalescing key is `runId:kind` for
   run finished/failed and `runId:kind:toolCallId` for `toolApprovalRequired`,
   so a run that suspends for more than one distinct approval still alerts on
   each. The input is a discriminated union carrying only `runId`/`kind`/an
   optional `threadTitle` (plus a REQUIRED `toolCallId` on the approval
   variant), never message content or tool args — and wires `onclick` to
   `window.focus()`.
3. **Settings UI** (`packages/preferences/src/settings/system/notification-settings-section.tsx`,
   registered via `createNotificationSettingsCategory()` from its own
   `notification-settings-category.tsx` — a non-component module, kept out of
   `settings-page-content.tsx` so Fast Refresh preserves `SettingsPageContent`
   state; imported in both `apps/web/src/app/settings/page-content.tsx` and
   `apps/desktop/src/renderer/components/settings/page-content.tsx`) —
   master + per-event toggles, surfaces a "blocked by your browser/OS"
   message when permission is denied/unsupported.
4. **Trigger source** (`packages/ui/src/assistant-ui-panel/run-lifecycle-notifications.ts`) —
   pure selectors (`selectTerminalRunEvents`, `selectOpenToolApprovalRequests`)
   scan thread messages for `run.finished`/`run.failed`
   (`ASSISTANT_RUN_EVENT_DATA_NAME`) and tool-approval-required
   (`TOOL_APPROVAL_DATA_NAME`) data parts. `useRunLifecycleNotifications`
   reports each NEW one exactly once (deduped via refs) through THREE new
   optional `AssistantUiPanelProps` callbacks — and DEFERS seeding its "seen"
   baseline until `state.thread.isLoading` is false, so async history
   hydration (opening/reloading an existing thread first renders an empty
   snapshot) seeds the replayed history without firing stale notifications
   (`onRunFinished`/`onRunFailed`/`onToolApprovalRequired`) that thread the
   SAME 5 layers as `onUsage` (`AssistantUiPanel` → `LocalRuntimeChat`/
   `DataStreamRuntimeChat` → `ChatThreadUI`, which mounts
   `RunLifecycleNotificationBridge`). This package NEVER touches
   `window.Notification` or the preferences store — it only reports raw
   events, mirroring the `onUsage` seam.
5. **Composition** (`packages/app-shell/src/use-assistant-run-notifications.ts`,
   wired into `assistant-ui-panel-wrapper.tsx`) — the ONLY layer that reads
   live `document.hasFocus()`/`visibilityState` and owns a
   `createRunNotificationDispatcher` instance (stable for the panel's
   lifetime, so per-run coalescing is meaningful). Hosted turns coalesce on
   the wire `runId`; web local-runtime events carry no `runId`
   (`createLocalRunEvent` assigns only a per-event `id`), so the hook falls
   back to `event.id` — a stable, unique key, never a fabricated runId that
   could collide across runs. Desktop's hidden
   embedding/llm hosts (`embedding-host-app.tsx`, `llm-host-app.tsx`) never
   import `AssistantUiPanel` at all, so they structurally can never notify —
   this hook only ever runs inside the visible assistant surface.

When changing this flow, update this section and the paired tests
(`packages/preferences/src/__tests__/notification-*.test.ts(x)`,
`packages/ui/src/assistant-ui-panel/__tests__/run-lifecycle-notifications.test.ts`,
`packages/ui/src/assistant-ui-panel/__tests__/run-lifecycle-notifications-hydration.test.tsx`,
`packages/app-shell/src/__tests__/use-assistant-run-notifications.test.ts`).

---

## MODEL CATALOG MIGRATIONS (CRITICAL)

Adding, removing, or renaming a supported AI model is a multi-layer change. Updating only the static registry is NOT enough — the in-app model picker is driven by a DB-backed catalog.

When changing the model catalog:
1. Update the static registry (single source of truth):
   - packages/assistant-contract/src/provider-registry.ts
2. Add a numbered DB migration that upserts/deletes catalog rows, and register it in BOTH:
   - packages/db/src/migrations/index.ts (numbered MigrationRunner — used by tests)
   - the `customMigrations` ledger in packages/db/src/drizzle/migrate.ts (used by the real app)
   - Registering in only one means tests pass but existing users never see the change.
3. Preserve user choices on kept rows with `ON CONFLICT (id) DO UPDATE SET ... is_enabled = models.is_enabled`.
   - INVARIANT: never use `is_enabled = EXCLUDED.is_enabled` for a catalog refresh — it clobbers the user's toggle. Force on/off only for a deliberate (e.g. security) swap.
4. Remap dropped IDs in the preference stores so persisted selections don't dangle:
   - MODEL_ID_MIGRATIONS in packages/preferences/src/stores/assistant-preferences-store.ts (bump its store version)
   - MEMORY_MODEL_TARGET_MIGRATIONS in packages/preferences/src/stores/assistant-memory-preferences-store.ts (also self-heals on every rehydration)
5. Register any new `packages/db/__tests__/*.test.ts` in BOTH `packages/db/scripts/test-lanes.mjs` AND `packages/db/scripts/coverage-lanes.mjs` — they are two separate lane registries (unit lanes vs nightly coverage lanes) and each errors on an unassigned test file. Registering only `test-lanes.mjs` passes every PR check but silently breaks the **Nightly Coverage** job (the historical cause of issue #1101). Verify both: `node scripts/test-lanes.mjs check` and `node scripts/coverage-lanes.mjs check` (the Static job runs both on every PR).
6. Every LLM model entry MUST declare `contextWindow` (and `maxOutputTokens` when documented) in
   packages/assistant-contract/src/provider-registry.ts — compile-enforced, static-registry-only
   (no DB migration). It drives the thread context meter and the auto-derived
   `agentLoop.inputTokenLimit` (see packages/assistant-contract/src/context-budget.ts).

---

## PGLITE EXTENSION INVARIANT

Every PGlite construction site MUST load the same engine-extension set, or the
corresponding `CREATE EXTENSION` migration fails with a cryptic "could not open
extension control file" error on that path only:

- `vector` (pgvector, from `@electric-sql/pglite-pgvector`)
- `pg_trgm` (from `@electric-sql/pglite/contrib/pg_trgm` — powers `brainstrike.grepSearch` trigram prefilter, migration 038)
- `pg_textsearch` (BM25 index AM, from `@electric-sql/pglite-pg_textsearch` — CONSUMED by migration 053 (`idx_file_chunks_content_bm25`), which powers the BM25 lexical arm of hybrid search; the ranking expression references the index BY NAME via `to_bm25query`, so a construction site missing this module breaks BOTH the migration and every fullTextSearch call. Proofs: `search-bm25-textsearch-spike.test.ts` (BM25 1/12 vs ts_rank 12/12 on the IDF-discriminating corpus) + `search-bm25-empirical-gate.test.ts` (production-shape filtered plan, websearch fuzz, post-build index maintenance, default_limit ordering, 511 ms index build at 50k chunks))
- `live` (client-side reactive queries — loaded everywhere EXCEPT the two live-less worker hosts: `pglite-worker-entry.ts`, where the PGliteWorker client installs it, and `browser-first-run-bootstrap-worker.ts`, whose short-lived bootstrap instances serve no reactive queries)

Construction sites (keep in sync when adding extensions or new sites):
- packages/db/src/wasm-loader.ts (cached loaders + HMR reset in `resetExtensionCaches`)
- packages/db/src/pglite-worker-entry.ts (engine extensions only)
- packages/db/src/browser-first-run-bootstrap-worker.ts (engine extensions only; the dedicated first-run bootstrap worker — see BROWSER FIRST-RUN FAST BOOTSTRAP)
- apps/desktop/src/db-main.ts (main-process host; ambient type shims live in apps/desktop/src/types/)

Tests that construct PGlite directly and run migrations must also pass the full
extension set (see drizzle-migrate.test.ts / drizzle-job-queue-compatibility.test.ts).

---

## BROWSER FIRST-RUN FAST BOOTSTRAP (idb:// STORES)

A genuine first run of the web app used to pay ~53s creating `idb://web-pg18`:
initdb + every migration under strict durability, where each statement awaits a
full IDBFS `syncfs` round (#1111). The fast path creates a MISSING store
greenfield in seconds — WITHOUT ever relaxing durability on the persistent
store:

1. initdb + all migrations run in a throwaway `memory://` PGlite.
2. `dumpDataDir('none')` captures the migrated data dir as a tarball.
3. A short-lived STRICT (`relaxedDurability: false`) PGlite opens the real
   `idb://` store with `loadDataDir: <tarball>`; one explicit awaited
   `syncToFs()` flushes the whole data dir to IndexedDB in a single pass
   (atomic: IDBFS reconcile is ONE readwrite transaction and its callback
   fires on `transaction.oncomplete`).
4. Only after that flush (plus an existence re-probe) is bootstrap complete;
   the long-lived strict worker client then opens the store exactly as before.
   The #1111 guarantee therefore holds for every byte the store ever sees.

Layers:
- Orchestration (probe/marker/lock/recovery):
  `packages/db/src/browser-first-run-bootstrap.ts`, wired in `db-provider.tsx`'s
  `initializeDirectPGlite` for `idb://` paths.
- Pipeline (memory migrate → dump → strict load → flush) over injectable PGlite
  constructors: `browser-first-run-bootstrap-pipeline.ts`.
- Production execution: a DEDICATED plain worker
  (`browser-first-run-bootstrap-worker.ts` + `-worker-entry.ts` — a PGlite
  construction site, engine extensions vector + pg_trgm) driven by
  `wasm-loader.ts`'s `runFirstRunBootstrapInWorker` over a two-message
  `{type:'run',dataDir}` → `{type:'result',ok,error?}` protocol with a
  fail-loud 5-minute timeout.

Invariants (do not regress):
- NEVER rebuild this on "relaxed bootstrap + syncToFs + strict reopen": on a
  relaxed instance PGlite's public `syncToFs()` fire-and-forgets the underlying
  flush and `close()` does not flush at all (verified against
  @electric-sql/pglite 0.5.4 src/pglite.ts). Dump/load into a strict instance
  is the only public-API path with a guaranteed awaited flush.
- NEVER run the bootstrap through PGliteWorker sessions: its leader-election
  machinery rejects in-flight RPCs with 'Leader changed, pending operation in
  indeterminate state' when the asynchronously delivered leader-here/leader-now
  events land after the client starts issuing RPCs — ephemeral sole-member
  groups hit this readily under load (observed live in dev; it failed DB init).
  The dedicated worker has no election and no RPC layer, and the dump never
  crosses a thread boundary. The shared `pglite-worker-entry.ts` host stays
  untouched (no `loadDataDir` on its wire — so a leader takeover can never
  replay a stale load).
- Crash safety: a localStorage marker
  (`brainstrike.pgliteFirstRunBootstrap:<dataDir>`) is written before the first
  IndexedDB write and cleared only after the strict flush. marker+store on a
  later launch ⇒ the partial store is deleted (warn-logged) and the bootstrap
  re-runs greenfield — safe because a store whose marker never cleared cannot
  contain user data. Factory reset's blanket `localStorage.clear()` covers the
  marker.
- Capability-gated, never silent: missing IndexedDB / Web Locks / usable
  localStorage each SKIP with an explicit logged reason (the pre-existing
  strict slow path runs instead, slower but equally correct); a bootstrap
  FAILURE rejects into DbProvider's visible init error state — no fallback.
- Multi-tab: serialized on the `brainstrike-pglite-first-run:<dataDir>` Web
  Lock; the loser re-probes inside the lock and skips (`existing-store`).
- Scope: browser `idb://` only (including the per-session `idb://web-e2e-*`
  Playwright stores, which get the same speedup). `opfs-ahp://`
  (worker-host-only backend, far cheaper syncs) and desktop (native FS via
  Electron main) keep their existing paths.

Paired tests: `packages/db/__tests__/browser-first-run-bootstrap.test.ts`
(orchestration/marker/probe), `browser-first-run-bootstrap-pipeline.test.ts`
(phase ordering/cleanup), `browser-first-run-bootstrap-worker.test.ts`
(protocol + STRICT store-load PGlite option pinning),
`browser-first-run-bootstrap.integration.test.ts` (REAL PGlite +
fake-indexeddb over the production pipeline: durable fast bootstrap across
reopen, strict post-ready writes, torn-store recovery),
`wasm-loader-worker.test.ts` (worker runner protocol/timeout), and
`db-provider-first-run-bootstrap.test.tsx` (wiring order + error surfacing).

---

## ASSISTANT SEARCH TOOLS

The assistant's search verbs, in the order the default instructions present them:
1. `brainstrike.grepSearch` — FIRST for exact strings, identifiers, error messages. Two-phase: trigram-indexed ILIKE/regex-literal prefilter (`FileChunkRepository.findGrepCandidates`) + authoritative JS line matcher (`GrepSearchService` in packages/db/src/search/). Regex patterns with no extractable ≥3-char literal fall back to a bounded scan surfaced via `scanLimited` (never silent). Desktop-only wiring in apps/desktop/src/assistant-server/grep-search-tool.ts. Progressive disclosure: default `outputMode: 'files'` returns per-path match counts (cheap survey); `outputMode: 'content'` returns line matches with context; both support `offset` paging.
2. `brainstrike.queryEmbeddingSpace` — semantic search when exact wording is unknown.
3. Hybrid FTS+vector RRF fusion (`HybridSearchService`) backs UI search paths. The
   lexical arm is MATCH-PRESERVING BM25 (migration 053): matching stays tsvector
   (`content_tsvector @@ tsqueryFunc(...)`, so plain/websearch/phrase semantics are
   unchanged) while ORDERING is `-(content <@> to_bm25query(q, 'idx_file_chunks_content_bm25'))`
   — negated so `FTSSearchResult.rank`/`ftsRank` stay higher-is-better (unbounded,
   corpus-dependent; ts_rank-era fixed thresholds do not transfer). `, id` tiebreaks
   keep ordering deterministic (BM25 ties are common). `rankNormalization` is inert.
   RRF fuses rank POSITIONS, so the fusion layer is unchanged.

Tool output budget (anti-thrash contract): budgets are token-denominated (`NATIVE_TOOL_RESULT_TOKEN_BUDGET` 2750, guard `MAX_TOOL_RESULT_TOKENS` 3000 in packages/agent/src/stream/tool-output-limits.ts) and enforced deterministically on serialized chars at 4 chars/token (mirrors `countTokensHeuristic`). Native tools self-bound their result lists via `fitItemsToCharBudget` and return SUCCESSFUL partial results with `truncated: true`, totals, and an actionable `hint` (offset/filters) built INSIDE the budget-fitted candidate — never a size error. The transport guard (`boundToolOutputForModel`) is a backstop: oversized collection-shaped outputs (matches/entries/results/items/files/chunks/rows) are structurally trimmed to fit with the same truncated+hint contract; only opaque non-collection outputs (e.g. MCP strings) still produce the `tool_result_too_large` error+preview, reported in ~tokens. Do not reintroduce hard size failures for native tools. `listWorkspaceContext` is concise by default (counts + token budgets); `detail: true` returns per-file Tapestry ranges.

Adding/renaming an assistant native tool is multi-registry: zod schema + schemaMap in packages/agent/src/tools/schemas.ts, agent package exports, NATIVE_TOOL_DEFAULTS (tool-categories.ts), TOOL_DESCRIPTIONS, NATIVE_TOOL_SCHEMAS (tool-schemas-display.ts) — all in packages/assistant-contract — plus the live registry in apps/desktop/src/assistant-server/assistant-tools.ts and the model-facing guidance in packages/agent/src/mastra/default-instructions.ts.

---

## WORKSPACE INSTRUCTIONS CONTEXT (AGENTS.md / AGENT.md / CLAUDE.md)

Each mounted workspace root's top-level instructions file is auto-injected into
the assistant's system context as a PREPENDED `system` message every turn.
**Desktop-only** (needs fs + the assistant server; web has no injection path —
capability-gated, no `isElectron()` checks). Sibling to `referenced-files-context.ts`.

- **Injection** (`apps/desktop/src/assistant-server/workspace-instructions-context.ts`)
  wired at the SAME request boundary as `injectReferencedFilesContext`
  (`assistant-server.ts` `resolveInitialAgentStream`): referenced-files first,
  then workspace instructions LAST so the general conventions land FRONTMOST.
  Per root, first-match-wins over `AGENTS.md` → `AGENT.md` → `CLAUDE.md` at the
  root's top level, read through `readWorkspaceTextFile`'s existing
  containment/size/binary guards (NO new raw-fs read path). Headings are
  qualified by `root.displayName` (two roots that both ship `AGENTS.md` stay
  distinct). Budgets mirror referenced-files: `MAX_CONTEXT_FILE_CHARS` = 12_000
  per file, `MAX_CONTEXT_FILES_TOTAL_CHARS` = 48_000 aggregate — a HARD ceiling:
  a file that would OVERSHOOT the aggregate is counted as omitted (the injected
  total never exceeds 48_000), with an honest omission note. Truncation of an
  opted-in oversized file never splits a UTF-16 surrogate pair (a lone surrogate
  at the cut boundary is dropped). Skipped ENTIRELY for provider `'local'` (the
  built-in Gemma's whole context budget is 8,192 tokens — mirrors the
  personas/plan-mode local exclusions).
  - **Read-failure discrimination (no fabricated absence):** `findRootContextFile`
    returns a discriminated `{kind:'found'|'none'|'error'}`. Only a GENUINELY
    absent candidate (ENOENT) advances to the next name; a PRESENT-but-unreadable
    candidate (binary, over the 2 MB read cap, EACCES/EIO, containment violation,
    not-a-file) short-circuits to `'error'`. Injection LOGS a warn and omits that
    root (never a prompt note, never a silent "no file"); the Settings scan maps
    it to `status:'error'` → an "Unavailable" badge with the detail. A >2 MB
    `AGENTS.md` therefore shows as Unavailable, not silently dropped.
  - **Legacy fallback is fail-closed:** oversized opt-in is defined only for
    DB-backed roots. A DB-less legacy root (synthesized from `workspaceRootPath`,
    `rootId` = raw path) can never appear in the DB-driven Settings scan, so its
    opt-in is un-settable and its oversized file stays un-injected.

- **THRESHOLD-HYBRID policy** (product ruling — never a silent drop):
  - A file that FITS the per-file budget → auto-injected WHOLE by default (no note).
  - An OVERSIZED file (> per-file budget) → NOT injected by default; requires an
    explicit per-root opt-in. When opted in, injected TRUNCATED at the budget with
    an honest note. When NOT opted in, it is NOT injected and NO skip-note goes in
    the prompt — it is surfaced in the Settings UI as "detected but not injected
    (too large — N KB / ~M tokens)" instead.
  - A master enable toggle (default ON) covers the whole feature.
  - Dogfooding reality: this repo's own `AGENTS.md` (~30KB) is OVERSIZED, so the
    opt-in path is the modal case here.

- **Preference** (`packages/preferences/src/stores/workspace-instructions-preferences-store.ts`) —
  persisted `{ masterEnabled: true, oversizedOptInByRootId: Record<rootId, boolean> }`
  keyed by durable DB `roots.id` (NEVER a raw path); only `true` opt-ins are
  stored. Reset via the direct-call seam in `factory-reset-helpers.ts` (mirrors
  `notification-preferences-store`, per the FACTORY RESET CONTRACT). The renderer
  attaches a plain-JSON snapshot to the request `runtimeData.workspaceInstructionsPreference`
  (contract type `WorkspaceInstructionsContextRequest`), gated to the desktop
  data-stream transport like `permissionPolicyRequest` — but this is a
  PREFERENCE, not a security boundary: the server reads it directly (no
  server-side re-derivation, unlike the permission gate). It is still parsed
  strictly — `readWorkspaceInstructionsPreference` DROPS a malformed field (a
  non-object preference, non-boolean `masterEnabled`, non-object opt-in map) with
  a warn rather than silently coercing it, then applies the fail-safe default
  (master ON, no oversized opt-ins).

- **Settings UI** (`packages/preferences/src/settings/system/workspace-instructions-settings-{section,category}.tsx`,
  registered in the DESKTOP page-content only) lists each mounted root's detected
  file with name, size, ~token estimate (chars/4, consistent with
  `countTokensHeuristic`), injection status, and the oversized opt-in toggle. It
  reads a per-root scan from `window.contextFiles.scan()` — IPC
  (`ipc-context-files{,-handlers}.ts`, channel `context-files:scan`, preload
  `contextFiles` bridge, capability-gated) whose main-process handler loads roots
  from the DB (`loadWorkspaceRootsFromDatabase`) and reuses the injection path's
  `findRootContextFile` (`workspace-instructions-scan.ts`) so status/oversized
  decisions are byte-identical to injection. A rejected `scan()` (DB unavailable,
  IPC failure) renders a DISTINCT, logged error state with a Retry button — NEVER
  the empty "no folders" state (which would falsely claim the workspace is empty).

- **Trust posture (accepted risk — conscious ruling):** injection is
  default-ON with NO per-root trust gate, unlike the Tool-Lifecycle Hooks
  feature (SHA-256 per-root approval). A mounted repo's instructions file
  becomes a high-authority `system` message automatically on mount — accepted
  because (a) content injection is already ungated here (`referenced-files-context.ts`),
  so this is not a new class of exposure, only default-on + automatic; and
  (b) the permission engine defaults mutation tools to `ask`, so injected text
  cannot silently drive edits/exec. The master toggle (and per-root oversized
  opt-in) are the user's off-switches. A future per-root acknowledgment of
  newly-detected files is a possible hardening, not a v1 requirement.

- **Deferred**: Mastra skills adoption (on-demand `createSkill()` per-root
  instructions — the architecturally better long-term fit, blocked on verifying
  its auto-added `skill`/`skill_search`/`skill_read` tools flow through the
  permission gate); web (no workspace-tool bridge); prompt caching.

When changing this flow, update this section and the paired tests
(`packages/preferences` store + settings-section + factory-reset tests;
`apps/desktop/src/assistant-server/__tests__/workspace-instructions-{context,scan}.test.ts`;
`apps/desktop/src/__tests__/ipc-context-files-handlers.test.ts`;
`packages/app-shell` request-builder test).

---

## USER-DEFINED SLASH COMMANDS

Prompt-template `/commands` authored as `*.md` files, projected into the SAME
composer "/" menu as the built-in app commands (they are a second *kind* of entry
in the existing `SlashCommand[]` flowing through `unstable_useSlashCommandAdapter`
— no new autocomplete). **Desktop-only by construction**: discovery reads disk in
the main process; web has no `window.userCommands` bridge and the hook returns
`[]` (capability-gated, never `isElectron()`).

- **Discovery (main):** `apps/desktop/src/ipc-user-commands*.ts` +
  `assistant-server/user-slash-commands-loader.ts` scan `*.md` in PRIORITY order,
  first-name-wins: (1) `<root>/.brainstrike/commands/` per mounted root, (2)
  `~/.brainstrike/commands/`, (3) `<root>/.claude/commands/` (Claude Code compat),
  (4) `~/.claude/commands/`. Scan HIGHEST priority first (the mastra-code-ui
  reference inverted this — do not copy that bug). Recursive with directory
  namespacing (`git/commit.md` → `git:commit`); cross-root collision keeps the
  first-mounted + warns once (mirrors use-file-mentions.ts's warn-once set). Roots
  resolve via `loadWorkspaceRootsFromDatabase` (DB `roots.id`, never a raw path);
  a DB failure still loads GLOBAL commands (logged, not silent). Fs is
  dependency-injected for unit tests.
  Command `.md` files are UNTRUSTED repo content, so the scan is BOUNDED
  (`user-slash-commands-loader.ts`): a per-file cap `MAX_USER_COMMAND_FILE_CHARS`
  (64K) skips oversized files with a visible warn-once (the real-disk `readFile`
  also `statSync`-gates so main never blocking-reads a giant file), and a
  `MAX_USER_COMMANDS` (500) count cap ignores the rest with a warn — never a
  silent truncation or a hard error that kills the whole scan.
- **Frontmatter:** hand-rolled `---\nkey: value\n---` parser
  (`parseUserCommandFile` in packages/assistant-contract — NO YAML dep) for
  `name`/`description` only; unknown keys ignored, and Claude Code multiline-YAML
  continuation lines (`- item` list entries, `# comments`) are TOLERATED/ignored
  (so real `.claude/commands` files with `allowed-tools:` lists load); a leading
  UTF-8 BOM is stripped before fence detection; other malformed/unterminated
  frontmatter fails CLOSED (skipped + visible error, never a silent half-parse).
  No frontmatter = whole file is the template. The id is path-derived
  (namespaced); `name` becomes the label only; `description` is fuzzy-searched by
  the popover adapter + shown as the item tooltip.
- **Composer wiring (renderer):** `packages/app-shell/src/use-user-defined-slash-commands.ts`
  is merged into `useAssistantSlashCommands(threadId)` via `mergeSlashCommands`
  (app commands first; a user command whose id COLLIDES with an app command is
  DROPPED with a warn-once — the pinned adapter's `onExecute` is find-first, so a
  listed collision would run the app command from the user's row). `execute()`
  reads the LIVE composer draft (the app-shell mirror
  `assistant-composer-command-store.draftTextByThreadId`, fed by
  `onComposerTextChange`), extracts any args, expands, and WRITES the expansion
  back via `enqueue({ mode:'replace' })` — never auto-sends (the user sees + edits
  before sending). `removeOnExecute: true`, uniform with app commands. No active
  thread → a visible toast (not console-only). The list reloads on mount, on
  mounted-root change, and on window `visibilitychange` (so a file edited while
  backgrounded appears without a full reload).
- **Arguments — placeholder-fill (F1, pinned-library constraint):** the pinned
  `@assistant-ui/react` trigger popover closes at the FIRST whitespace after
  `/id` (`detectTrigger` returns null), so INLINE `/cmd args` capture is
  UNREACHABLE in the live flow — the arg string is always empty at selection.
  `expandUserCommandTemplate` therefore leaves any unfilled `$ARGUMENTS`/`$N`
  token LITERAL as a VISIBLE placeholder the user fills in the composer before
  sending (never a silent empty blank). Do NOT re-document inline args as working,
  and do NOT add send-time expansion (no-silent-expansion is binding).
- **Expansion (pure, renderer-safe, `expandUserCommandTemplate`):** a SINGLE
  tokenizing pass (F2) so substituted argument text is NEVER re-scanned — a
  `$100` or `$1` the user types as an argument survives verbatim. `$ARGUMENTS` =
  full args (else visible placeholder); `$1..$N` positional (absent → visible
  placeholder). Template `@path` tokens become `:file[basename]{name=encoded}`
  directives via `encodeFileMentionId`, so the existing referenced-files pipeline
  resolves/reads/budgets them for free (NO new file-reading); args INSIDE a
  template `@…$1` path are substituted BEFORE serialization so a `}` in the arg is
  percent-encoded and cannot truncate the directive into a different file. Root
  binding: a root-scoped command binds to its `sourceRootId`; a GLOBAL command
  binds to the single mounted root, else leaves the token literal for the `@`
  popover (NO silent guessing). User-supplied `@` argument text stays literal —
  only template `@paths` convert.
- **SECURITY HARD LINE:** there is NO shell (!\`command\`) expansion, gated or
  not, ever — it passes through as inert text (proofs in the contract, loader,
  and hook specs). Do not add it.

Paired tests: packages/assistant-contract/src/__tests__/user-slash-commands.test.ts,
apps/desktop/src/__tests__/assistant-server/user-slash-commands-loader.test.ts +
ipc-domains/ipc-user-commands-handlers.test.ts,
packages/app-shell/src/__tests__/use-user-defined-slash-commands.test.tsx +
use-assistant-slash-commands.test.ts (F4 merge), and the REAL-trigger
packages/ui/src/assistant-ui-panel/__tests__/slash-commands.behavior.test.tsx
(F1 placeholder-fill through the actual popover + adapter + write-back).
Explicitly DEFERRED: shell expansion (never), web (no workspace-tool bridge),
namespaced/categorized popover grouping, Mastra skills.

When changing this flow, update this section and the paired tests.

---

## EDIT CHECKPOINT JOURNAL (UNDO OF AGENT FILE EDITS)

Every agent file mutation records an undoable journal entry so a per-tool-card
**Revert** control (and a per-turn **Revert all edits** footer) can restore the
prior state. Desktop-only (web local chat has no assistant server / thread_runs
rows). Capability-gated, not `isElectron()`.

- **Capture point:** INSIDE the existing per-file `withFileLock` in all four
  `run*WorkspaceFile` functions (`assistant-tools.ts`), so the before-read →
  mutate → journal write is atomic against concurrent same-file edits.
  `toolCallId` comes from Mastra's 2nd `execute` arg
  (`context.agent.toolCallId`, verified against @mastra/core@1.50.0 dist types);
  identity (runId/threadId/resourceId) from `runtimeData.memory`. Capture is
  GATED on an active memory context and is NON-FATAL (debug on DB-absent, error
  on DB-throw) — the tool result contract is never changed.
- **Storage:** full BEFORE-content (capped at the 2 MB write limit), not a diff,
  so revert is an exact independent write and conflict detection is a hash
  compare. `after_hash`/`after_existed` are for conflict detection only (no
  after-content — redo is deferred). Binary/oversized before-state is recorded
  honestly via `capture_status` (`skipped_binary`/`skipped_too_large`) with null
  content — NEVER a truncated snapshot. `capture_status` enum:
  `ok`/`created`/`skipped_binary`/`skipped_too_large`/`expired`/`rename`; only
  `ok`/`created`/`rename` are revertible.
- **Table** `brainstrike_assistant_edit_checkpoints` (migration 051, registered in
  BOTH runners + bootstrapped byte-identically in app-shell's
  `assistant-memory-repository.ts`). NO FK (mirrors run_usage 046 — the numbered +
  drizzle migration paths run on a bare PGlite without the thread_runs/mastra_threads
  parents; an FK would break the full migration suite). Purged on factory reset
  (`db-ipc.ts` `OptionalRelationTable`).
- **Retention** (`edit-checkpoint-journal.ts`, strict-parsed env, no silent
  fallback): `BRAINSTRIKE_CHECKPOINT_CONTENT_BUDGET_BYTES` (32 MB) NULLs the oldest
  non-reverted before-content to `expired`; `BRAINSTRIKE_CHECKPOINT_MAX_ROWS`
  (500) hard-deletes the oldest rows. Pruned after every insert.
- **LIST = renderer-direct DB (Path A):** `listThreadCheckpoints(threadId)` on the
  PGlite repository, across ALL runs (revertible after reload). `before_content`
  is NEVER selected — it stays in main.
- **REVERT = IPC to main (Path B):** `window.assistantCheckpoints.revertEntry/revertRun`
  → `assistant-checkpoint:revert-*` → `edit-checkpoint-revert.ts`. Resolves the
  stored `root_id` via the roots table and REFUSES a disconnected root (never
  guesses); detects on-disk conflicts (hash compare, `force` overrides); applies
  the per-op inverse (restore-write / delete-created / recreate-deleted /
  rename-back) under the file lock; reuses the write tools' non-fatal reindex
  seams; stamps `reverted_at` (idempotent). Reverts are NOT re-journaled.
  `revertRun(runId)` reverts every non-reverted entry of a run in reverse apply
  order and is HONEST about partial success — one conflicting file returns an
  `ok:false conflict` outcome without aborting the rest.
- **UI = per-entry button + per-turn footer.** The per-tool-card
  `CheckpointRevertButton` (`tool-fallback.tsx`, keyed by `toolCallId`) undoes one
  edit. The per-turn `CheckpointTurnRevert` footer (`checkpoint-turn-revert.tsx`,
  its own module for the assistant-panel line budget) mounts on every
  `AssistantMessage`: it reads the turn's tool-call parts from assistant-ui
  message state (`useAuiState(state => state.message.parts)` — same discriminant
  live and on reload) and resolves the true revert scope via `selectTurnRevertScope`
  against ALL of the thread's journal entries. Because the default `edit:ask`
  policy splits ONE run across several live assistant messages (each approval
  resume appends a new message sharing the runId) while `revertRun(runId)` reverts
  the WHOLE run, the footer is **run-scoped**: it renders once per run — on the
  run's LAST leg (the message holding the run's last-applied revertible tool call,
  its "anchor") — and its count is the run's full revertible-entry total
  (including `toolCallId:null` entries that never render but still revert), so the
  shown count always equals what reverts. It reverts each owned run **sequentially,
  newest first** (a shared file edited by two runs must revert in reverse order —
  `Promise.all` can't guarantee it), through the SAME `revertRun` bridge.
  Both controls mirror one UX contract — confirm → revert, on-disk conflict →
  "Revert anyway" (force), idempotent after success (reverted entries drop out on
  refetch). The turn footer additionally surfaces a **visible failure state**: an
  unexpected executor throw or an all-fail non-conflict result (e.g. a
  disconnected-root `not_revertible`, whose actionable message is shown) sets a
  `failed` phase with a retry — never left stuck disabled in `reverting`, never a
  silent return to idle. Pure capability gating: `null` on web / for turns whose
  message owns no revertible run, never a disabled stub.
- **Live-turn availability + reconciliation.** The footer must appear for the
  turn that JUST ran (its headline "undo what the agent just did" scenario). The
  journal rows are written in main DURING tool execution — after the thread-open
  read — so `useEditCheckpoints` exposes a `refetch` the wrapper composes into the
  run-lifecycle `onRunFinished`/`onRunFailed` seam (no polling); a monotonic
  generation guard drops a stale refetch that resolves after a newer one (mid-revert
  thread switch). A `revertRun` that unexpectedly rejects (partial on-disk revert)
  refetches BEFORE rethrowing so the per-entry/turn controls reconcile.
- **Key files:** `edit-checkpoint-{journal,capture,revert,errors}.ts` +
  `ipc-domains/assistant-checkpoint-*.ts` (desktop),
  `edit-checkpoint-context.tsx` (context + `selectTurnRevertScope` /
  `useCheckpointTurnRevert`) + `tool-fallback.tsx` + `checkpoint-turn-revert.tsx`
  (ui), `use-edit-checkpoints.ts` (app-shell — `revertEntry`/`revertRun` wired to
  the bridge with refetch-on-success + refetch-before-rethrow, plus the run-completion
  `refetch`) + `assistant-ui-panel-wrapper.tsx` (composes refetch into the run
  callbacks), `packages/assistant-contract/src/edit-checkpoints.ts`.

When changing this flow, update this section and the paired tests.

---

## WORKSPACE SEARCH

The Explorer|Search panel (`packages/workspace-search`, composed by
`packages/app-shell/src/use-workspace-search-controller.ts` +
`explorer-search-tabs.tsx`).

- **Renderer-only execution.** BOTH modes (text/grep and semantic) query the DB
  from the renderer via the platform repositories — NO assistant-server
  dependency. Text mode uses `GrepSearchService`; the controller prefers the
  platform `chunkRepository` when it exposes `findGrepCandidates` (desktop's
  ElectronFileChunkRepository) and falls back to a query-only PGlite
  `FileChunkRepository` on web.
- **Always workspace-scoped.** Every query passes `rootIds` = live mounted
  workspace roots (`rootIdentity.workspaceDbRootIds`); legacy NULL-root rows are
  excluded. Empty rootIds = no results (never an unscoped scan).
- **In-flight invalidation.** The session store (`workspace-search-store.ts`)
  carries a monotonic `generation`; `beginSearch` + every mode/collection/toggle
  change (and `clearResults`) increment it, and `resolveResults`/`failSearch`
  no-op unless the generation still matches — a superseded run can never clobber
  fresher state. A text query shrinking below the 3-char minimum calls
  `clearResults` (drops stale matches + bumps the generation so the in-flight
  longer-query run cannot resurrect them).
- **Tree shape (chunk-first).** Text mode is `file → chunk → match`
  (`build-tree-nodes.ts` groups matches by `chunkId`, node id `c:${chunkId}`):
  the CHUNK row carries the only child checkbox (bridge `toggleChunk`/`chunkState`
  keyed by `chunkId`), match rows (`m:${chunkId}:${line}`) are navigation-only
  leaves. Semantic mode stays `file → chunk`. The chunk is the single visible
  selection unit — a per-match checkbox flipped its chunk siblings. `resolveResults`
  default-expands file ids AND every text `c:${chunkId}`. Every row reserves the
  expand-toggle column (`reserveToggleSpace` default) so file (depth 0) and chunk
  (depth 1) checkboxes align per level at `depth*20 + 28`px — a leaf chunk without
  the reserved spacer would indent LEFT of the file checkbox (pinned in
  `search-results-tree.test.tsx`).
- **Line-/range-targeted open.** Row click → `onOpenFile(compositeKey, target?)`
  where `target = { line; selection? }` (match rows pass `{ line }`; chunk rows
  ALSO pass `selection: { startLine, endLine }`) → controller
  `openFileInTab(compositeKey, { line, selection? })` (ide-layout seam) →
  `workspace-tab-host` records a one-shot view target (transient, non-persisted
  `targets` slice of `editor-view-state-store`) → `CodeSurface` `initialLine`
  scrolls to the match, and `initialSelection` scrolls to AND selects the chunk's
  full line range (a real read-only CodeMirror selection, so the block is
  highlighted and ready to ⌘C). `initialSelection` wins over `initialLine`/
  restored scroll. `FileTabBody` clears the store target for that key once
  `content` has rendered (consuming it exactly once) — so a later
  tab-switch-away-and-back or close/reopen, which remounts `CodeSurface` (keyed
  on `compositeKey`), reads no target and falls back to the restored scroll
  position instead of re-applying the stale target.
- **Bridge invariant (set-based, no silent data loss).** The selected-chunk SET
  is the SOURCE OF TRUTH (`chunk-selection-store.ts`: session-lived
  `selectionsByKey[compositeKey][chunkId] = {chunkId,startLine,endLine}`). Tapestry
  ranges are a ONE-WAY derived OUTPUT — after every set mutation
  `use-search-selection-bridge.ts` re-emits `deriveSearchRanges(setValues)` (spans
  sorted + merged into the minimal covering set, stamped `origin:'search'`)
  alongside the preserved non-search ranges. Because ranges are output-only,
  merging is now SAFE (checkbox state reads the set, never the ranges) — this is
  the fix for the old subtraction-bleed defect where unchecking one overlapping
  chunk flipped its sibling. Chunk checkboxes are BINARY (`chunkState` by
  `chunkId`); the file checkbox is the ONLY tri-state (`fileState`: whole-file
  `checked` when selected with empty subset, `indeterminate` when a chunk subset
  exists, else `unchecked`). Whole-file minus one chunk is now expressible:
  unchecking a chunk under a whole-file selection CONVERTS to "every sibling result
  chunk except this one" (`toggleChunk`'s 4th arg is the file's full result-chunk
  list). Search still writes ONLY explorer file-selection + its own
  `origin:'search'` ranges; it preserves every range with `origin !== 'search'`
  on the same file verbatim through every mutation. There is no default/auto-created
  range to preserve (see TAPESTRY below) — a rangeless file is simply whole-file.
  An emptied search set writes no `[]` residue: the curation store deletes the
  key so absence-of-ranges = whole-file everywhere (empty ≡ absent).
  Round trips are idempotent: emptying the chunk subset (or the last chunk) also
  deselects the file. The curation store's snapshot producer remains the
  preview panel.
- **Not-ready sync guard.** `syncTapestryRanges` (`tapestry-range-sync.ts`) never
  clamps or records a `totals` baseline for a file whose `contentStatus !==
  'ready'` — pre-content `totalLines` is an untrusted placeholder that would
  otherwise squash a bridge-written `[1,8)` span to `[0,1)`. Ranges only
  reconcile (clamp to the real total) once content lands; there is no
  default-range stretch step (see TAPESTRY below — rangeless files stay
  rangeless).
- **Session-only.** The store is not persisted; it is reset on factory reset via
  the `registerFactoryResetSessionStore` seam (app-shell registers it — see
  FACTORY RESET CONTRACT). The active Explorer|Search tab persists in
  context-explorer-layout-store v3 (`explorerActiveTab`).

When changing this flow, update this section and the paired tests.

---

## MARKDOWN VIEWER (FILE TABS)

Every file tab renders a slim `FileTabHeader` (filename + directory + actions
slot). Markdown files (.md/.markdown/.mdown/.mkd — NOT .mdx, source-only)
additionally get a Source/Preview toggle; preview is the default.

- **Surfaces:** `CodeSurface` (source) vs `MarkdownSurface`
  (packages/ui/src/markdown-surface/ — react-markdown v10 + remark-gfm +
  remark-math/rehype-katex + rehype-slug; shiki fences share the chat's cached
  highlighter via packages/ui/src/shiki/highlighter-core.ts; ```mermaid fences
  lazy-load mermaid). Raw HTML stays inert (no rehype-raw). Frontmatter is
  pre-extracted (packages/ui/src/markdown-surface/frontmatter.ts) into a
  properties block; invalid YAML renders visibly.
- **Mode state:** persisted per compositeKey in editor-view-state-store
  (`modes`, store version 2); preview scroll under `preview:${compositeKey}`.
  A one-shot view target (search-match open) forces source TRANSIENTLY without
  writing the store.
- **Capabilities (injected, never isElectron()):**
  `MarkdownPreviewCapabilitiesProvider` (file-explorer-ui) composed by
  app-shell's `useMarkdownPreviewCapabilitiesValue`. External links: desktop →
  `window.platform.openExternal` (allowlisted http/https/mailto in MAIN,
  apps/desktop/src/ipc-shell-handlers.ts); web → window.open noopener. Images:
  desktop → `brainstrike-asset://local/asset?path=…` (protocol handler in
  apps/desktop/src/asset-protocol.ts realpath-validates containment in mounted
  DB roots; CSP img-src includes the scheme); web → FS Access handle →
  object URL (revoked on unmount). Remote http(s) images are BLOCKED in the
  renderer (visible placeholder) — untrusted file content must not trigger
  network requests, independent of CSP. Every failure is visible (placeholder,
  toast, or error block) — no silent fallbacks.
- **Crash safety:** MarkdownPreviewErrorBoundary offers "Open in source".

When changing this flow, update this section and the paired tests.

---

## TAPESTRY

The per-file range model spans Explorer, Search, Tapestry, and every context
consumer (report generator, `listWorkspaceContext`, token meters).

- **Per-file rule, no global toggle.** "Files are membership, ranges are
  refinement, no ranges = whole file" — unconditional everywhere
  (`useTapestryRanges` retired). Selecting a file is membership ONLY; nothing
  seeds a materialized whole-file range. `syncTapestryRanges`
  (`tapestry-range-sync.ts`) never creates ranges for a rangeless key, only
  clamps existing ones once content is ready. Tapestry renders a rangeless
  selected file as an implicit whole-file state (soft tint, "Whole file"
  label, no drag handles); the first drag or a Search chunk check creates
  explicit ranges.
- **Reset means clear manual clips.** `TapestryControls`' "Clear manual clips"
  action → `TapestryView`'s `onResetRanges` → `preview-panel.tsx`'s
  `handleResetTapestryRanges` removes every visible file's user-owned ranges
  (including `userModified`) but preserves the latest `origin:'search'`
  ranges. A file with no remaining ranges returns to implicit whole-file
  context; Search remains the sole owner of its derived clips.
- **`origin:'search'` is one-way derived.** Workspace Search's chunk-selection
  set drives it (see WORKSPACE SEARCH's bridge invariant above); hand-edit
  machinery never writes or reads it, and any `userModified` ranges on the
  same file survive every search mutation untouched.
- **Spatial precision and context actions.** The overview is deliberately
  bounded for large files; the pointer-following code lens and click-pinned
  precision selector resolve exact lines against ready content. Only one
  pinned selector may own the gallery at a time. Tapestry right-click actions
  use immutable `tapestry-document` / `tapestry-range` targets projected by
  the shared `ActionContextMenu`; range color, include/exclude, exact-create,
  and clear actions are surface-local registry actions with explicit
  `ActionOutcome` failures. Never reintroduce hand-rolled Radix menus here.
- **Four deliberate default-user behavior changes (spec-approved; do not "fix"
  back):** (a) `report-generator.ts` framing flips from a whole-file
  `<selection>` wrapper to bare `<file>` for untouched files (content
  identical); (b) `rangeAdjustedFilesCount`/`activeRangeFilesCount` stop
  counting untouched (rangeless) files; (c) `outputApproxTokens` is the file's
  real token count instead of `null` when rangeless; (d) token meters/
  summaries lock to the single "Output" presentation (no per-mode toggle).
- **Key files:** `packages/file-explorer-ui/src/utils/tapestry-range-sync.ts`,
  `packages/file-explorer-ui/src/preview/preview-panel.tsx`,
  `packages/utils/src/report-generator.ts`,
  `apps/desktop/src/assistant-server/assistant-tools.ts` (`listWorkspaceContext`
  `detail: true` gate for per-file ranges).

When changing this flow, update this section and the related tests.

---

## CONTEXT USAGE METER (TOKEN AWARENESS)

One derivation feeds three consumers per request — keep them consistent:
`buildAgentLoopSettings(prefs, selectedModelBudgetDef)` in packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts
produces `agentLoopSettings.inputTokenLimit` (explicit user pref wins, else
`deriveEffectiveInputBudget(contextWindow, maxOutputTokens)` from
packages/assistant-contract/src/context-budget.ts — throws, never clamps). That ONE number is:
1. the Mastra `TokenLimiter` budget (`runtimeData.agentLoop.inputTokenLimit` → `buildToolLoopOptions`),
2. the meter denominator (`effectiveInputBudget` prop on `AssistantUiPanel`),
3. the instruction budget note (`buildContextBudgetNote`, appended per-request at Agent construction).

Runtime invariants:
- Usage store (packages/ui/src/assistant-ui-panel/context-usage-store.ts) is session-lived, NOT
  persisted; key = `selectedMemoryThreadId ?? 'active'` — the writer (`handleUsage` in the app-shell
  wrapper) and the reader (`ContextUsageMeter`, via the panel's `threadKey` prop) MUST use the same key.
- Both turn paths report usage: hosted via the data-stream `message-finish` tap
  (`onUsage` in data-stream-runtime.ts), local via the llm-host result (`onUsage` in
  local-runtime-adapter.ts; `LocalLlmGenerationResult.usage` is optional at the IPC boundary — guard it).
- The meter shows estimated (heuristic over thread messages) until exact usage lands; provenance
  must never lie — wire-format usage is `{inputTokens, outputTokens}` (e2e mocks must use those names).

---

## LOCAL LLM ARCHITECTURE (CRITICAL)

Renderer-only execution is mandatory for the built-in local LLM path.

Rules:
- Local Gemma inference MUST run in renderer (browser context).
- MUST NOT run in Electron main process.
- Desktop MUST use the hidden `llm-host` renderer for built-in local LLM work.
- Web MUST use the browser-safe `@brainstrike/agent/local-llm` entrypoint.

Reasons:
- Transformers.js Gemma runtime depends on browser/WebGPU surfaces that are renderer-only.
- Running model load/generation in Electron main would degrade to the wrong runtime surface and risks UI/process instability.
- Hidden-host execution avoids visible-renderer throttling and keeps the UI responsive during model warmup/generation.

Flow:
1. Hidden host renderer (desktop)
   - Files:
     - apps/desktop/src/llm-host-manager.ts
     - apps/desktop/src/ipc-llm-host.ts
     - apps/desktop/src/llm-host-shared.ts
     - apps/desktop/src/renderer/components/llm-host-app.tsx
     - apps/desktop/src/renderer/components/llm-host-runtime.tsx
   - Main creates a hidden BrowserWindow with `?mode=llm-host`.
   - The host renderer owns `LocalLlmBackend` initialization, warmup, generation, and progress events.
   - The host renderer reports status/progress/response back to main over dedicated IPC channels.
2. Desktop chat path — local THROUGH the Mastra loop (data-stream)
   - `AssistantUiPanel` prop `localChatTransport` ('data-stream' on desktop,
     'local-runtime' otherwise) — set by the app-shell wrapper when the
     assistant backend AND `window.llmHost` bridge exist. Desktop local chat
     POSTs to the assistant server like hosted providers, gaining Mastra
     memory persistence, run events, tool guards, and the stream watchdog.
   - The renderer pre-warms the model (existing download-progress badge UX,
     `warmDesktopLocalModel` in local-runtime-adapter.ts) before the request;
     the server also warms as a safety net. Llm-host request timeouts are
     INACTIVITY windows (generate 5 min, warmup 20 min): every progress
     report extends the deadline by the full window, so long generations
     that stream progress survive while a silent/wedged host still times out.
   - `LocalLlmBackend.generate` SERIALIZES generations (single engine, single
     WebGPU session — overlapping model.generate calls corrupt it). The Mastra
     loop's chat steps and a local observational-memory observation can
     legitimately overlap; the backend queue is the chokepoint for every
     consumer (`dispose` takes a queue turn too). Do not rely on caller-side locks.
   - Engine-fault recovery (llm-host-runtime.tsx): a generate-stage GPU fault
     (narrow `ENGINE_FAULT_PATTERN` — high-signal substrings only) disposes the
     engine and RETRIES the generation ONCE, announced via a 'stage' progress
     report + logs (never silent). A fault that survives the retry reports the
     visible "engine was reset" error. Aborts never trigger recovery.
     `ENGINE_FAULT_PATTERN` also matches the ONNX-Runtime GPU-memory-exhaustion
     markers that carry NO "gpu" substring (`ortrun`/`bad_alloc`/`safeint`/
     `integer overflow`): prefilling a prompt larger than the device's WebGPU
     memory aborts ORT with one of those, and without matching them a single
     overflowed tool turn poisons local chat for the whole session.
   - Device-wedge escalation (engineReset flag): disposing the ORT session is
     NOT enough for a GPU-memory fault — it wedges the whole WebGPU DEVICE, and a
     transformers.js tensor-disposal leak (huggingface/transformers.js#860)
     keeps the leaked buffers alive, so the next generation reloads into a dead
     device. The renderer sets `LlmHostErrorDetails.engineReset` on the recovery
     error report; `LlmHostManager` escalates to a debounced host-window
     `reset()` (a fresh device) so the NEXT message recovers automatically. Only
     persistent faults (dispose+retry already failed) flag it, so it is not
     over-aggressive. Proof: llm-host-runtime.test.tsx + llm-host-manager.test.ts.
   - GPU prompt ceiling: the q4f16 Gemma 4 E2B WebGPU runtime OOMs at prompts in
     the low thousands of tokens (≈3-4K on a typical device — far below the
     architectural ~128K). Gemma 4 E2B is therefore declared at the RUNTIME
     budget `contextWindow: 8192` / `maxOutputTokens: 2048` in
     packages/assistant-contract/src/provider-registry.ts (NOT the architectural
     window) so the context-budget machinery + meter keep assembled prompts in
     the working zone; the engineReset escalation handles the residual
     device-dependent overflow. A leaner local system-prompt/tool-schema
     footprint is the deeper follow-up for reliable local tool-calling.
   - Loading badge smoothing (use-local-model-loading.ts): parallel per-file
     progress reports are folded into a mean aggregate with a stable
     "(completed/total)" message and the laggard file as the label, throttled
     to one update per 250ms (stage changes apply immediately). Unkeyed
     reports keep the monotonic floor instead.
   - Server side: `LlmHostManager.generateForMain/warmupForMain` (main-process
     client API with progress callbacks + AbortSignal cancel) →
     `createMainLlmHostClient` (apps/desktop/src/assistant-server/local-llm-host-client.ts)
     is injected as `RuntimeData.localLlmHostClient`; provider-factory's
     'local' case resolves it to `LlmHostChatModel`
     (packages/agent/src/providers/local/llm-host-chat-model.ts) — a real
     LanguageModelV2 that converts cumulative host text/reasoning snapshots
     into incremental deltas. NEVER serialized over IPC/HTTP.
   - Local memory models ride the same seam: 'local/<model>' observational
     memory targets resolve keyless to the proxy model; 'local/<model>'
     semantic-recall targets resolve to `createLocalHostEmbeddingModel`
     (queries proxied to the embedding host; dimensions from the models
     catalog). Both throw clear errors if their host manager is missing.
   - Live-loop proofs (no agent mocks): packages/agent/src/__tests__/
     mastra-local-host-execution.spec.ts (chat + tools through the real
     provider factory) and the local-OM test in mastra-memory-persistence.spec.ts.
3. Visible renderer (web local chat, and desktop status/warmup UX)
   - Files:
     - packages/ui/src/assistant-ui-panel/local-runtime-adapter.ts
     - packages/ui/src/assistant-ui-panel/use-local-model-loading.ts
     - packages/app-shell/src/assistant-ui-panel-wrapper.tsx
   - Does NOT run the built-in local LLM directly in desktop mode.
   - Talks to the hidden host over the preload bridge (`window.llmHost`).
   - WEB still uses the in-renderer `LocalRuntimeChat` (assistant-ui local
     runtime; session-only, no Mastra loop) — there is no assistant server in
     the browser.
4. Main
   - Files:
     - apps/desktop/src/main.ts
     - apps/desktop/src/preload.ts
   - Does NOT execute Gemma inference in-process (the Mastra loop runs in
     main, but every generation is proxied to the hidden llm-host renderer).
   - Owns hidden-host lifecycle, IPC registration, and shutdown/reset coordination.
5. Shared local runtime
   - Files:
     - packages/agent/src/local-llm.ts
     - packages/agent/src/providers/local/local-llm-backend.ts
     - packages/agent/src/providers/local/gemma4-engine.ts
     - packages/agent/src/providers/local/local-model-specs.ts
     - packages/agent/src/providers/local/local-artifact-store.ts
     - packages/agent/src/providers/local/local-message-conversion.ts (shared
       AI-SDK v2 ↔ local dialect: preserves assistant tool calls, parses V2
       tool-result `output` envelopes)
   - `local-llm.ts` is the browser-safe entrypoint for renderer usage.
   - `LocalLlmBackend` is a thin orchestrator over the Gemma engine/spec/artifact layers.
   - On web, tool calls are executed through the UI/runtime tool bridge; on
     desktop they run through the Mastra agent loop like hosted providers.

Constraints:
- Built-in local model downloads are manifest-based, not single-file heuristics.
- Thinking/reasoning output must be kept separate from the final visible answer.
- Control tokens (`<turn|>`, EOS markers, tool-call wrappers, etc.) must be stripped from visible output.
- If you change the local host lifecycle, preload bridge, or availability gating, update this section and the relevant tests.

---

## TREEGRID CONVERGENCE CONTRACT

File-tree and context preview tree behavior is converging on shared TreeTable primitives.

Rules:
- Use `packages/ui/src/tree-table/*` as the canonical treegrid implementation.
- Prefer adapting feature surfaces to TreeTable API over duplicating tree render logic in app/package code.
- Keep UX parity between:
  - File explorer tree (left nav).
  - Context explorer grouped preview tree (main panel).
- Preserve WAI-ARIA treegrid semantics (`role="treegrid"`, row/level metadata, keyboard traversal).
- Keep the shared `TreeTableViewport` as the sole two-axis scroll owner and the
  virtualizer's scroll element. Consumer wrappers must remain layout-only
  (`overflow-hidden`); do not reintroduce nested `overflow-auto` wrappers or a
  split header/body scroller. The semantic table and sticky header belong in
  that same viewport.

Windowing and performance:
- Default strategy should remain `auto` unless a product requirement explicitly pins behavior.
- For search-heavy and large result flows, paged windowing is acceptable when it produces more stable UX than virtual scrolling.
- Avoid full-tree rematerialization during render paths; keep derived rows memoized and keyed by stable node ids.
- Any new tree interaction (selection, sort, collapse, keyboard behavior) must include tests in both shared UI package and consuming feature package when behavior diverges.

When modifying TreeTable strategy or pagination behavior:
- Update the related collection browser/file explorer/context preview adapters.
- Add or update tests validating grouped slicing semantics and selection correctness.
- Document intentional tradeoffs (e.g., paged vs virtual) in code comments or PR notes.

---

## CONTEXT ACTION SYSTEM

Right-click menus are projections of a shared action system. Do not hand-roll
per-surface context menus (coordinate state + positioned DropdownMenu is the
legacy pattern; it was removed from the collection browser).

Layers:
- Headless core: packages/context-actions — ContextTarget union, ContextAction,
  createActionRegistry, ClipboardService, path helpers. No React rendering, no
  Electron imports.
- Renderer: packages/ui/src/context-menu — Radix ContextMenu wrapper +
  ActionRegistryProvider + ActionContextMenu + useContextMenuTarget.
- Composition: packages/app-shell/src/context-action-registry.ts builds the
  registry (capabilities from the bridges that exist) and mounts the provider
  in root-layout-content.tsx. Feature actions are imported via subpath exports
  (@brainstrike/db-explorer/context-actions,
  @brainstrike/file-explorer-ui/context-actions) to preserve code-splitting;
  assistant thread copy actions are app-shell-owned. Do NOT import feature-package
  root barrels from always-mounted code.
- Desktop bridge: window.platform (preload) → 'shell' IPC domain →
  apps/desktop/src/ipc-shell.ts (validates absolute paths, catches shell throws).
- Desktop clipboard: window.clipboard.writeText (preload) → 'clipboard' IPC
  domain → apps/desktop/src/ipc-clipboard.ts; the write runs in MAIN and the
  bridge resolves { ok, error? }. It must NOT call Electron's clipboard module
  from the preload — sandboxed preloads (sandbox is on outside test mode)
  cannot require it, which silently breaks every write on real builds.

Rules:
- Capability gating hides actions (no disabled "available on desktop" items).
  Web simply never constructs 'fs.reveal'. No isElectron() checks in action or
  menu code.
- Every action run resolves to ActionOutcome; failures MUST toast + log
  (createLogger('ContextActions')). Thrown/rejected runs are caught by the menu
  and surfaced as "Action failed unexpectedly". No silent fallbacks: a
  present-but-broken bridge reports failure, never degrades quietly.
- Action ids are globally unique for an invocation. Registry construction rejects
  duplicate global ids, and `actionsFor` rejects global/local collisions instead
  of letting renderer order choose an ambiguous executor.
- Adding an action: define it with defineContextAction in the owning feature
  package, add it to that package's exported action array, cover run/gating in
  unit tests.
- Adding a surface: add a target kind to ContextTarget, write a node→target
  adapter, claim the target in the surface's row contextmenu handler via
  controller.setTarget, reset it with onContextMenuCapture on the container,
  wrap with ActionContextMenu. Surface-local actions (closures over surface
  stores) go through the localActions prop, not the global registry.
- Targets are immutable invocation snapshots, not live DOM/store lookups. Claim
  them synchronously during the `contextmenu` event. File viewer targets preserve
  exact text (including whitespace) plus the CodeMirror `{from,to}` range from
  the same event; Markdown selection must be bounded to its preview root. A
  durable file `RootId` is identity, commonly a UUID — resolve its descriptor
  path before building relative/absolute paths and never treat the id as a path.
- Context triggers must stop before native editable/selection surfaces. Thread
  row menus wrap only the non-editing display (rename inputs keep the native
  edit menu), thread-tab menus wrap only the tab lane (assistant message content
  keeps its native selection menu), and pinned workspace app tabs are not file
  targets.
- Multi-tab actions execute atomically in the owning Zustand store. Preserve a
  selected pinned app while mutating background file tabs; assistant bulk closes
  update open/active/selected maps together and never mutate durable thread
  history or per-thread draft runtime. Revalidate targets at execution so a menu
  opened against a tab that later closes becomes disabled/fails explicitly.
- `shortcut` is semantic presentation metadata (`primary` maps to Cmd/Ctrl), not
  keyboard ownership. `registry.descriptorsFor(...)` is the serializable boundary
  for a future native context-menu adapter: main may receive descriptors and
  return the chosen action id, but the target and executor stay renderer-owned.
  Never serialize action functions or React icons over IPC. A persistent Electron
  application/File menu additionally requires explicit focused-target ownership.
- Destructive thread actions are staged: row `Delete…` enters the existing inline
  confirmation flow and never deletes durable history directly from a menu run.
- Adding a capability: extend CapabilityKey, construct it in
  createAppActionRegistry only when the backing bridge is fully formed
  (malformed bridges log an error and stay absent).
- Known limitation: Radix touch/pen long-press (~700ms) bypasses the
  contextmenu claiming protocol — desktop-first tradeoff, documented in
  action-context-menu.tsx.

When changing this flow, update this section and the related tests.

---

## CODING STYLE AND NAMING

Stack lock:
- Language: TypeScript.
- Apps: React 19+ with Vite for `apps/web`; Electron renderers use React.
- Package manager: pnpm workspaces.
- Styling: Tailwind CSS v4 and shared `@brainstrike/ui` components.
- Testing: Vitest for unit/integration and Playwright for E2E.
- Persistence: local-first state and PGlite-backed storage where applicable. Do not introduce round-trip API dependencies into latency-critical paths without an explicit requirement.

- TypeScript strict; noImplicitAny: true.
- Never use any. Prefer unknown + narrowing.
- Annotate function parameters, return types, and object literals.
- Prefer:
  - Utility types (Partial, Pick, etc.).
  - Discriminated unions over enums (for exhaustiveness).
  - Generics with constraints when useful.

Naming:
- Filenames: kebab-case.
  - file-explorer.tsx, utility-functions.ts
- Components:
  - File: kebab-case
  - Export: PascalCase
- Hooks:
  - File: use-kebab-case.ts
  - Export: camelCase (e.g. useDataFetcher)

Reuse shared packages; avoid copy-paste divergence.

---

## TESTING EXPECTATIONS

- Frameworks:
  - Vitest for unit/integration.
  - Playwright for E2E.
- Naming:
  - *.test.ts
  - *.integration.test.ts
- Example:
  - pnpm vitest run -t "test name" (from package dir)

CI parity:
- Builds, types, lint, unit/integration, and E2E must pass before merge.
- Desktop E2E can be flaky in headless; diagnose, don’t bypass.

---

## LOGGING (PINO V10)

Centralized logging: packages/utils/src/logger.ts

Usage:
- Use initializeLogging from @brainstrike/utils.
- Set runtime: browser | electron-main | electron-renderer.
- Desktop main:
  - Logs to console + ${app.getPath('logs')}/brainstrike.log
- Web/renderer:
  - Call initializeLogging in main.tsx.

Log levels:
- trace, debug, info, warn, error, fatal, silent
- Configure via:
  - setLogLevel(LogLevel.DEBUG)
  - LOG_LEVEL=debug (env)
- Priority: code > env > defaults.

Structured logs:
- Prefer objects:

  logger.info('User authenticated', { userId: '123', method: 'oauth' });

Scoped loggers:
- createLogger('FileImporter')

Sensitive data:
- Auto-redacts: apiKey, password, token, secret, authorization, cookie
- Add more via redactPaths.

Testing:
- Use addLogListener instead of mocking console.

---

## FACTORY RESET CONTRACT

“Factory Reset Brainstrike” = true fresh start.

Rules:
- Wiping DB alone is NOT enough.
- Renderer must boot as if never used.

Implementation:
- Update:
  - packages/preferences/src/settings/system/factory-reset-helpers.ts
  - Ensure clearPersistentUiState() includes:
    - All new persistent UI store keys (e.g. `hook-trust-store` — the
      security-sensitive per-root hook approvals; reset drops every approval so a
      re-mounted repo's hooks require fresh review — see TOOL-LIFECYCLE HOOKS).
    - Electron renderer storage bridge.
    - IndexedDB (enumerated + fallback list).
    - CacheStorage.

If you add new persistence (Caches API, service worker, filesystem handles, etc.):
- Document it next to the helper.
- Integrate into reset pipeline.
- Otherwise stale embeddings/providers may reappear.

Desktop reset order:
1. Dispose embeddings.
2. Clear UI state.
3. Purge DB tables (job_queue, embedding_sets, etc.).
4. Reload renderer.
Do not skip reload.

Add tests when changing reset behavior.

---

## LIVING DOCUMENT

This file must be kept accurate:
- Update when commands, tools, architecture, or security constraints change.
- Treat AGENTS.md as the primary source-of-truth for both AI agents and humans.

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config Biome preset that enforces strict code quality standards through automated formatting and linting. Most formatting and common issues are automatically fixable.

## Quick Reference

- **Format code**: `pnpm dlx ultracite fix`
- **Check for issues**: `pnpm dlx ultracite check`
- **Diagnose setup**: `pnpm dlx ultracite doctor`

Run `pnpm dlx ultracite fix` before committing to ensure compliance.
