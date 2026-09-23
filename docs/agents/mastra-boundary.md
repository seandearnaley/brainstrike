# Mastra Boundary: Server, Workspace, Browser, RequestContext, Streaming, Observability

> Read before adding a `@mastra/*` package, registering anything new on the
> `Mastra` instance, or moving a Brainstrike-owned surface behind a Mastra one.
> Rules here are true now; the record behind each is in `mastra-boundary/<topic>.md`.
> Installed: `@mastra/core@1.64.0` (patched) and `@mastra/memory@1.28.2`.

## SCOPE AND STATUS

- Rulings R1–R10 are the `##` sections below, in order; each states what
  Brainstrike owns and what Mastra is allowed to own.
- Reopen a ruling only with a named capability Brainstrike lacks today, and
  record the new decision here in the same change. Why: this boundary lived in
  ticket comments and evaporated across four sessions before it was written down.

Settled: every ruling ratifies shipped behaviour; none required a migration.
Evidence: `mastra-boundary/ratification-history.md`.

## R1 SERVER BOUNDARY

- Mastra is an embedded library runtime. The scoped instance
  (`packages/agent/src/mastra/agent-runtime.ts`) registers no `server`,
  `observability`, or `scorers` key in any literal form and no opaque spread that
  would make that unverifiable. It is constructed per request, is not constructed
  without storage (so hosted web never has one), and only `shutdown()` is called.
- Brainstrike owns every assistant HTTP surface on both platforms: entry, auth,
  origin/CORS, body parsing, streaming, persistence. Web persists nothing,
  deliberately; desktop owns resumable sessions and the run/event/outcome tables.
- Do not install a Mastra server adapter, deployer, or `@mastra/mcp`.

Guard: `scripts/__tests__/mastra-boundary-contract.test.mjs`.
Evidence: `mastra-boundary/server-boundary.md`.

### Why not Mastra Server

- Anchor the ruling to "core ships no HTTP server", not to "hono and express are
  absent from the tree" — both are in the lockfile for unrelated reasons, and the
  guards assert the former.

Settled: rejected on cost — an adapter moves ownership of auth, CORS, secrets and
the desktop loopback lifecycle for no capability Brainstrike lacks. Do not
relitigate without a named capability that requires one.
Evidence: `mastra-boundary/why-not-mastra-server.md`.

### First-class subagents: host lifetime decision

- Build first-class subagents on `Agent` plus Brainstrike's own host services;
  `AgentController` would duplicate permission, workspace, run, and thread
  ownership. Limits live in `assistant-subagents.md`.
- Acquire the root conversation's FIFO execution owner before constructing Mastra
  or opening a turn checkpoint, hold it through background work and parent
  continuations (`background-idle-loop.ts`), and release on session closure and
  terminal persistence — including when the transport subscriber detaches.
- Keep background retries at zero. The HOST owns each task's deadline: the user's
  runtime limit via `resolveChildTaskTimeoutMs` (Off = Node's longest timer), and
  a suspension clears the timer, so waiting for a human never spends it.
- Cancel through explicit resource/thread/native-parent-run filters, and join the
  workflow write, outstanding executor, and workflow deletion before
  acknowledging Stop. Never build a runtime that might restart unrelated work,
  never stop the shared manager to cancel one task, and cancel pending approvals
  only on an explicit root Stop. A cancelled row does not prove workspace effects
  stopped; a held flush raises an explicit cleanup error at the native shutdown
  deadline rather than succeeding or waiting forever.
- Compose a delegated child's `abortSignal` with its parent tool signal. Why:
  core 1.64.0 otherwise overwrites the child signal with the parent's.
- Remove a patch hunk only when its native regression passes against the upstream
  replacement.
- Do not pass `untilIdle`. Why: Mastra's loop wakes the parent model on a child's
  suspension; the host loop wakes it only for a returned, failed, or cancelled
  task.

Settled: this lifecycle authorizes no Mastra HTTP server, no replacement
workspace tools, and no second permission or persistence system. Evidence:
`mastra-boundary/subagent-host-lifetime.md`.
Settled: the patch shares one xxhash-wasm instance across every `SemanticRecall`
(proven upstream defect, reported). Evidence:
`mastra-boundary/semantic-recall-wasm-leak.md`.
Guard: `packages/agent/src/mastra/__tests__/mastra-semantic-recall-hasher.spec.ts`.

## R2 NODE-BUILTIN CONTAINMENT (CRITICAL) — NEW

- Import `@mastra/core` only where Node builtins exist. Its shared chunks
  statically import `fs`, `child_process`, `os`, `path`, `module`, `url`,
  `stream`, `string_decoder`, and `crypto`, reachable alike from
  `@mastra/core/agent`, `/mastra`, and `/workspace`. There is no browser-safe
  entry point.
- Keep `@mastra/core` and `/^@mastra\//` in the vite externals of **both**
  browser bundles, `apps/web/vite.config.mts` and `apps/desktop/vite.config.mts`
  (the Electron renderer build). Why: breaking this is silent at build time and
  fails only at runtime in the browser.
- This constraint, not auth or CORS, is the real limit on how much Mastra can
  absorb, and it is why R3 and R4 resolve as they do. It composes with
  `docs/agents/local-inference.md`: Mastra on the Node side, local inference on
  the renderer side.

Guard: `scripts/__tests__/mastra-boundary-contract.test.mjs`.
Evidence: `mastra-boundary/node-builtin-containment.md`.

## R3 WORKSPACE OWNERSHIP

- Brainstrike's native workspace tools stay authoritative. Mastra Workspace
  (`createWorkspaceTools`, `LocalFilesystem`, `LocalSandbox`) is rejected: no
  identity or permission model, and `@mastra/core/workspace` pulls the
  Node-builtin chunk (R2).
- Resolve roots through `resolveWorkspaceRoot`
  (`apps/desktop/src/assistant-server/workspace-roots.ts`), which fails loud on
  ambiguous, stale, unknown, disconnected, or escaping input; path escape is
  checked after realpath on both sides (`workspace-path-resolution.ts`).
- Register desktop tool and skill ids at the single site
  `apps/desktop/src/assistant-server/assistant-tools.ts`, where an unknown id in
  the preference filter throws rather than being dropped.

Evidence: `mastra-boundary/workspace-ownership.md`.

## R4 BROWSER

- Browser-driving agents are not a product capability. Core ships only
  `abstract class MastraBrowser`; an implementation needs an uninstalled provider
  package plus a real Chromium, and is not renderer-viable (R2). `webExtract` is
  a Tavily HTTP call, not a driven browser.

Settled: reopening requires a product decision naming which runtime owns browser
state, credentials, consent, and desktop/web parity. Evidence:
`mastra-boundary/browser-scope.md`.
Guard: `scripts/__tests__/mastra-boundary-contract.test.mjs`.

## R5 REQUEST CONTEXT

- `RuntimeData` is the authoritative request-scoped carrier. Keep
  `RequestContext` to Mastra-reserved keys and ephemeral native-call correlation;
  add no product or `RuntimeData` fields, and pass host callbacks as direct
  runtime options.
- Keep client-supplied-then-re-derived fields (`permissionPolicy`, `hookRunner`,
  `mcpConfig`, `personaProviderApiKeys`, `workspaceSkills`, `workspaceRoots`) on
  the server side of `packages/assistant-service/src/stream-init.ts`. Why:
  `RequestContext.toJSON()` silently drops functions, symbols, and circular refs,
  so a trust boundary routed through it sits on a structure that cannot enforce
  one. TypeScript types alone are not a request trust boundary.
- Authorize a snapshot resume from durable host state, never a context entry.
- The class is `RequestContext`; `RuntimeContext` is not a Mastra export.

Settled: migrating stripped-and-re-derived fields into `RequestContext` is an
explicit non-goal; migrating wire-carried fields is permitted but unmotivated.
Evidence: `mastra-boundary/request-context.md`.

### Memory-model credential boundary

- Treat a serialized observational-model target as configuration only: resolve
  the provider credential first, then materialize the descriptor into a concrete
  `LanguageModel` carrying it. Never hand Mastra the bare routing string. Why: it
  would resolve credentials from its own environment or gateway and bypass the
  env/keychain contract.
- Require a concrete model whenever observational memory is enabled and throw
  before storage initialization when it is absent.
- Distinguish `disabled`, `resolved`, and `needs_async_resolution`; only the last
  consults the desktop credential resolver, and an absent credential after that
  lookup is a typed failure, never an implicit provider fallback.

Evidence: `mastra-boundary/memory-model-credentials.md`.

## R6 STREAM MAPPER OWNERSHIP

- Brainstrike's typed `StreamChunk` union is the UI and persistence contract.
  Adapt Mastra output into it; do not adopt Mastra's AI SDK UI stream or route
  layer at any AI SDK version. Baseline: AI SDK v7 provider packages on
  `@mastra/core` 1.64.
- Keep both stages Brainstrike-owned: Mastra chunk → `StreamChunk` in
  `packages/agent/src/mastra/agent-streaming.ts`, then `StreamChunk` → encoded
  frames in `packages/agent/src/stream/data-stream-mapper.ts`.
- Keep the R6 dispatch, OM data-part mapping, and public entry points in
  `agent-streaming.ts` — the guard pins that file by name. Pure decoders live in
  `mastra-chunk-decoding.ts`; chunk minting, tool-lifecycle state, approval and
  suspend pauses, and abnormal-ending policy are one module each under
  `packages/agent/src/mastra/`.
- Keep classification and watchdog mechanism out of the mapper: they belong to
  `provider-error-metadata.ts`, `mastra-chunk-decoding.ts`, `mastra-watchdog-options.ts`
  and the two `packages/agent/src/stream/with-*-timeout.ts` modules.
- Transient-vs-durable is a mapper decision, load-bearing for three rulings in
  `docs/agents/assistant-runtime.md`: run-event deferral across streaming text
  parts, `chunk.type === 'run-event'` as the durable-persistence discriminator,
  and the terminal Stop hook running before `message-finish`.

Evidence: `mastra-boundary/stream-mapper-ownership.md`.
Guard: `scripts/mastra-stream-chunk-contract.mjs`.

### Unknown-chunk policy — NEW

- Type the mapper against Mastra's exported `ChunkType` union so upgrade drift is
  a compile-time failure, and give every static member an explicit
  `'mapped' | 'ignored' | 'normalized'` disposition — presence is not a
  disposition. A widened upstream `string` union also fails the type check.
- At runtime an unrecognized chunk emits a coded warning plus a diagnostic event
  and keeps the stream alive; an unhandled dynamic-family member warns once per
  type per stream. Do not throw. Why: a Mastra minor adding a chunk type must
  fail in CI, not in a user's live run.
- `processMastraStreamPart` is the live untyped Mastra boundary; the other two
  dispatch defaults are backstops for runtime-unsound callers.

Settled: implemented and no longer architecture-gated; the guard's control cases
prove a silently-dropping default and a relocated warning both fail. Evidence:
`mastra-boundary/unknown-chunk-policy.md`.
Guard: `scripts/__tests__/mastra-stream-chunk-contract.test.mjs`.

## R7 MCP TRANSPORT AND CAPABILITIES

- MCP transport is ruled in `docs/agents/assistant-providers.md`,
  `## MCP TRANSPORT SELECTION (CRITICAL)`: explicit `stdio` / `streamable-http` /
  `sse` per server, official `@modelcontextprotocol/sdk` clients only, no
  automatic Streamable HTTP → SSE fallback. Capability and conformance decisions
  belong in `docs/agents/mcp-conformance.md`, not here.
- Keep `@mastra/mcp` out of every manifest and the lockfile. Why: a second
  connection lifecycle beside the SDK clients for no capability the SDK lacks.
- Default an unclassified MCP tool to risk `mcp`, never `read`
  (`packages/agent/src/mastra/permission-tool-gate.ts`).

Evidence: `mastra-boundary/mcp-capability-matrix.md`.
Guard: `scripts/__tests__/mastra-boundary-contract.test.mjs`.

## R8 OBSERVABILITY AND EVALS

- Pino logs, durable run events, the usage ledger, and diagnostic events remain
  the observability source of truth. `@mastra/observability` is not adopted: a
  second exporter topology over the same events with no consumer.
- Keep the four stores contractually separate — run events (thread cascade),
  diagnostic events (app-wide, warn+, bounded), the usage ledger (billing fact,
  no FK, unbounded by design), and the Pino log file.
- Redact run-event metadata by denial-list at construction and at both write
  sites (`packages/assistant-contract/src/run-events.ts`), and build tool
  lifecycle metadata from scratch with its four keys. Why: raw args, results, and
  error text must never reach a durable row.

Settled: R8 is deliberately unguarded — an absence assertion would encode the
constraint the next section retires. Evidence:
`mastra-boundary/observability-stores.md`.

### Correction to BST-561 — evals are NOT gated on this boundary

- Eval adoption proceeds on its own merits: `runEvals` and `createScorer` are in
  core and need no server, storage, or cloud; only prebuilt scorers need
  `@mastra/evals`. Write eval code against the installed `.d.ts`, not the docs.

Evidence: `mastra-boundary/evals-not-gated.md`.

## R9 WORKFLOWS AND RUN TIMELINE

- Workflow snapshots (`mastra_workflow_snapshot`) are runtime-resume state:
  written on suspend, read on resume and by pending-approval discovery, read by
  nothing else. Store references rather than payloads and keep `pruneSnapshot`
  pure and JSON-safe, because a snapshot may cross a pubsub boundary.
- The run timeline is the Brainstrike contract: the kinds in
  `packages/assistant-contract/src/run-events.ts`, persisted by two writers with
  byte-identical SQL. `Run.timeTravel()` is replay-with-injected-context, not a
  history browser, and does not substitute for it.
- Support typed suspension UIs and reject an unknown resume schema visibly; the
  transport envelope already validates and 400s
  (`packages/assistant-contract/src/tool-suspend.ts`).

Evidence: `mastra-boundary/workflow-snapshots.md`.

## R10 PROMPT STATE AND EDITOR

- Prompt Workbench owns user prompt and version state; PGlite is the only prompt
  store (`docs/agents/workspace-context.md`, `## PROMPT WORKBENCH`). Mastra Editor
  is not adopted, because Prompt Workbench already owns this state — not because
  of hosting.
- Keep assistant system prompts and workspace instructions separate; their source
  of truth is on-disk `AGENTS.md`/`CLAUDE.md` (`docs/agents/workspace-context.md`,
  `## WORKSPACE INSTRUCTIONS CONTEXT`).

Evidence: `mastra-boundary/prompt-state.md`.

## VERIFIED-FALSE PREMISES

- Check the recorded list before re-deriving a premise the tickets carried; each
  was checked against the installed package or the live tree and found false.

Evidence: `mastra-boundary/verified-false-premises.md`.

## PAIRED TESTS

- Update this contract and its guards in the same change. R1, R2, R4 and R7 are
  guarded by `scripts/__tests__/mastra-boundary-contract.test.mjs` (forbidden
  packages, registered config keys, both bundles' vite externals); R6 by
  `scripts/mastra-stream-chunk-contract.mjs` and its test; R8 is unguarded by
  design.

## RESOLVED CONTRACT MAINTENANCE

- The retired `context.budget`, `context.prepared`, and `context.selection`
  run-event kinds are rejected by the inbound guard; use `hook.notice` for
  informational timeline coverage. Add no backfill. Why: they never reached
  durable rows, so a migration would mutate local-first user data without evidence.

Evidence: `mastra-boundary/run-event-union-cleanup.md`.

## FOLLOW-UPS

- Decided here, implemented separately, none architecture-gated: replace the
  dead-end unknown-resume-schema notice (R9) with visible rejection.
- Flagged outside this boundary:
  `packages/app-shell/src/hooks/use-assistant-mcp-menu-state.ts` still collapses
  every MCP failure to a reasonless `ERROR` via a bare `catch`.
- `scripts/verify-minimum-release-age-exclusions.mjs` fails `pnpm lint` once a
  `minimumReleaseAgeExclude` entry ages past 30 days, so a stale pin exclusion
  cannot recur silently.

## 1.51 → 1.57 UPGRADE NOTES

- Narrow an inbound `ToolExecutionContext` to the slice a caller reads, and
  narrow with `'execute' in tool` before probing `ToolsInput[string].execute`.
  Why: `observe` is required while `createTool`'s context is typed as
  `{ requestContext }`, and the input type admits execute-less members.
- Keep `run_python`'s Gate A as the permission gate's ordinary `requireApproval`
  clone, Gate B as plain suspension, and the direct-invocation guard in-tool.
  Why: since 1.56 the framework consumes `{approved}` resumes before a tool can
  read them, which killed the old self-raised in-tool gate. There is no
  self-approving native tool registry.

Settled: the repo adopted the 1.56 idiom rather than holding below it. Evidence:
`mastra-boundary/upgrade-1-57.md`.
Guard: `packages/agent/src/__tests__/mastra-tool-suspend-resume.integration.spec.ts`
is the canary for approval-semantics drift.

## 1.57 → 1.59 UPGRADE NOTES

- Disposition `tool-output-denied` as `'mapped'`. Why: it is the decline terminal
  of the lifecycle `tool-call-approval` opens and no later `tool-result` carries
  that id, so ignoring it strands the renderer's tool part pending and leaves the
  durable `tool.started` unpaired.
- A decline is terminal but is not an error. Settle the call with the shared
  `DeclinedToolCallResult` envelope and its own `'declined'` status — no error
  flag, no visible failure text — and render the muted `stopped` treatment. Keep
  the durable event on the `tool.failed` kind and relabel only, because kind is
  what call-closeout aggregation keys on and the call really is over.
- Dispatch the declined part through `mapToolLifecyclePart` so a gated delegation
  emits its `subagent.failed` / `'cancelled'` terminal and never orphans a
  `subagent.started`.
- Keep `openai-duplicate-item-compat.ts`. Why: 1.59's shared-message-id fix does
  not retire the BST-1095 dedupe processor — `MessageList.add`'s sealed-boundary
  re-key still persists a second durable row, and the processor operates on the
  prompt, so it also protects threads written by older builds.

Settled 2026-08-15 on review: do not collapse decline into error again. Evidence:
`mastra-boundary/upgrade-1-59.md`.
Guard: `packages/agent/src/__tests__/mastra-tool-approval-chunks.spec.ts`,
`packages/agent/src/__tests__/mastra-tool-lifecycle.spec.ts`.

### `@mastra/memory` hold at 1.26.0 (BST-1320) — SUPERSEDED BY BST-1667

- `@mastra/memory` is pinned at 1.28.2 alongside `@mastra/core` ^1.64.0; the
  1.26.0 hold is history.
- Join `consumeStream()` at every attempt's cleanup boundary
  (`settleNativeStream`, contract in `docs/agents/assistant-persistence.md`).
  Why: core 1.64 awaits its post-run snapshot delete on terminal paths, but a
  caller abandoning the stream early (watchdog abort, Stop) still races it.
- Await `Memory.settled()` before closing the storage connection and keep the
  awaited `saveMessages` in `aborted-turn-persistence.ts`. Why: `settled()` joins
  observational-memory background work but not `MessageHistory`'s abort-time
  write, and forcing that seam off still wedges the worker.

Evidence: `mastra-boundary/memory-pin-and-pglite-close-race.md`.
Guard: `packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts`.

#### Root cause: a PGlite `close()` race, NOT an OM state leak

- The hazard is a PGlite `close()` race, not an observational-memory state leak:
  `close()` deactivates the WASM backend before awaiting shutdown, so a statement
  already past `_checkReady()` spins synchronously against a dead backend and
  neither promise settles. The event loop is blocked, so no test timeout or
  unhandled rejection can fire.
- Never drain with a `SELECT 1` flush, a sleep, or a `Promise.race` timeout: each
  is silent degradation and the last cannot fire against a blocked loop. The
  fixes are upstream (pglite#1084, mastra#21617); re-test a bump when that lands.
- Keep every PGlite close path joined against in-flight work: the desktop DB host
  is safe only while its envelope dispatch stays strictly serial, and the web
  direct reset path is where the class is reachable. Close paths are owned by
  `docs/agents/database.md`.

Evidence: `mastra-boundary/pglite-close-race.md`.

### Native background stream normalization

- Normalize the native background transport in `background-stream.ts` before the
  R6 mapper and keep native child envelopes on the same delegated projection and
  `StreamChunk` persistence path. A dispatch acknowledgement is not a child
  result; terminal parent usage includes every continuation leg.
- Give each native background lifecycle/output type a `normalized` disposition;
  an escaped one takes the ordinary coded unknown-part warning, and native EOF
  with unfinished work fails visibly.
- Register a selected child's cancellation capability on the actual Mastra
  runtime and remove it during disposal; the host revokes durable admission
  first, and no replacement runtime is created merely to cancel work.
- Deliver human input to an active child with `childAgent.sendSignal` and a
  canonical `createMessageSignal` persisted through native Memory first, using
  `ifIdle: discard`. Why: a raced completion must not wake an unowned
  continuation, and a new delegation call reusing the thread ID is not the
  supported path. Unknown or finished child owners fail visibly.
- Native proofs establish the transport only — not host admission, budget,
  decision, or human-composer integration.

Evidence: `mastra-boundary/native-background-streams.md`.
Guard: `packages/agent/src/__tests__/background-worker-stream.integration.spec.ts`.
