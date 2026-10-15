# ADR-0022: The web assistant calls the AI SDK directly, not a hosted host

- **Status:** Accepted by Sean
- **Date:** 2026-10-15
- **Ticket:** none yet
- **Completes:** [ADR-0012](0012-ai-sdk-loop-mastra-memory-library.md)
- **Evidence:** `docs/archive/web-assistant-engine-scoping-2026-10-15.md`,
  `docs/archive/host-tool-representation-measurement-2026-10-15.md`
- **Amended:** 2026-10-15 — the retirement step's file count; see Amendment below

## Context

ADR-0012 retired Mastra's agent loop for the desktop and recorded, as a
consequence, that "web chat goes through a stateless serverless proxy running
the AI SDK with hosted models and no tools". Three of those four clauses are
deployed. The fourth is not: `apps/web`'s assistant route reaches the AI SDK
*through* the retired loop — `route.ts` → `runWebAssistantPost` →
`toAiSdkStyleStream` (`message-utils.ts:301`) → `streamMastraAgent`. It is the
last production caller of that engine, and the reason 32.8K lines in
`packages/agent/src/mastra/` cannot be subtracted.

The engine contributes nothing to web. Web's capability envelope is set by the
allow-list in `web-assistant-runtime-schema.ts`, which rejects `mastraTools`,
`mcpConfig`, `memory`, `personas` and `storage` outright, and accepts-but-ignores
`model`, `agentLoop`, `enabledNativeToolIds` and `mcpEnabled`. Approvals and
stream resume are refused at the boundary as architectural (409). Web therefore
runs a multi-step, tool-calling, memory-backed engine as a single-step
`streamText` call with an empty tool map.

Making web a host client is not a transport swap. The host validates its
endpoint as a Unix socket path or a Windows named pipe (`host-lease/src/record.ts:13`)
and has no TCP listener; the browser cannot reach it, and the deployed CSP
(`connect-src 'self'`) would block another origin. The host also needs a flock'd
per-root lease, a `better-sqlite3` writer in a worker thread and three native
addons — none of which a Vercel function can hold across a 300-second ceiling,
and a function recycled mid-`log/subscribe` would abandon a live committed run
on a host no later request can reach.

## Decision

- **Web's assistant endpoint calls AI SDK 7 `streamText` directly.** The
  `toAiSdkStyleStream` → `streamMastraAgent` hop is replaced by a direct
  adapter emitting the same `StreamChunk` sequence `DataStreamMapper` consumes.
  `apps/web` stops depending on `@mastra/core` and `@mastra/memory`.
- **Web's capability envelope does not change.** No tools, no MCP, no memory,
  no personas, no server-side persistence, no approvals, no stream resume. The
  allow-list in `web-assistant-runtime-schema.ts` remains the trust boundary and
  keeps rejecting those fields. The workspace prompt preamble
  (`injectWorkspaceRootManifestContext`) is engine-independent and is preserved.
- **Web is not a host client, and no host runs off the user's machine.** The
  host protocol keeps its local transports; no network transport, per-user
  server data root, host supervisor or multi-tenant credential custody is
  introduced by this decision. A hosted backend, if ever wanted, is a separate
  product decision with its own ADR.
- **No host runs in the browser.** Reaffirms ADR-0012: the host requires
  `flock(2)` and compiled native addons; a browser re-implementation would be a
  second loop, permission system and persistence owner.
- **No fallback.** If the direct adapter cannot produce a chunk the mapper
  requires, that is a visible failure to fix. There is no runtime switch back to
  the Mastra loop and no degraded path.
- **Sequencing.** This lands behind the web assistant e2e restoration on the
  hosted data-stream transport (#3618), so stream parity is demonstrated rather
  than asserted.
- **Retirement, separately.** Once web no longer calls the loop, the engine is
  removed in three mechanical steps: move the tool-projection modules the *new*
  loop consumes out of `src/mastra/` into `src/tool-projection/`; drop the root
  re-exports of engine symbols from `packages/agent/src/index.ts` and re-point
  the nine desktop tests that use them; then delete every `src/mastra/` module
  that no surviving `package.json` export entry reaches and no non-test consumer
  outside `packages/agent` imports — where e2e helpers count as tests and are
  re-pointed, not preserved — recomputed immediately before the deletion lands.
  See [ADR-0023](0023-host-owns-its-tool-representation.md). Each is its own
  change.

## Consequences

- The last production caller of the Mastra agent loop goes away. The retirable
  set is computed by the rule in [ADR-0023](0023-host-owns-its-tool-representation.md)
  rather than fixed here; measured 2026-10-15 it is **66 files / 22,008 lines**,
  with 34 files / 10,839 lines surviving and relocated rather than deleted
  (10,839 + 22,008 = the directory total of 100 files / 32,847 lines, which is
  the check any recomputation should satisfy). Line counts are `wc -l`.
- `apps/web` stops tracing `@mastra/core` and `@mastra/memory` into its Vercel
  functions.
- `docs/agents/mastra-boundary.md` becomes true. It already says the agent loop
  is removed.
- Web gains nothing. It has no tools, memory or persistence today and has none
  after. Web users keep their data in browser PGlite, as now.
- Desktop/web capability divergence is made explicit rather than incidental, and
  stays that way until a hosted-backend decision changes it.
- A capability web might later want — tools, durable runs, cross-device threads
  — now requires that explicit decision, not an incremental slide. That is the
  intended effect.
- Known limit: stream-shape parity between the direct adapter and the engine's
  emission is the single real risk, and it is why this follows #3618 rather than
  leading it.

## Amendment (2026-10-15): the retirement step states a rule, not a count

As accepted, the retirement step said "delete the remaining 82 files" and
Consequences said 82 files / ~27,808 lines. Both were wrong in the same
direction, and acting on them would have deleted live code.

The 82 came from subtracting a tool-projection cluster that was seeded from a
hand-listed set of module names. That seed omitted published entries of
`packages/agent`. Most consequentially `./provider-request` and
`./provider-runtime`, which between them reach 13 `src/mastra/` modules: 12
through **runtime** imports, and `permission-policy-request` through a
type-only edge. Six are written against `@mastra/core/processors` —
`error-processors`, `tool-projection-rewrite-processor`,
`projection-safe-tool-call-filter`, `openai-tool-search-history-compat`,
`openai-duplicate-item-compat` and `bedrock-message-hygiene` — and
`error-processors` instantiates Mastra's own `PrefillErrorHandler`,
`ProviderHistoryCompat` and `StreamErrorRetryProcessor`. `token-measurement` is
not one of them: it reaches `@mastra/core/schema`, not the processor
interfaces. `./tool-runtime` and `./mcp-client` reach nine more. Deleting any of
them breaks a published entry.

Recomputing by seeding from the public entries instead moved the figure four
times — 83, 79, 75, 69 — each revision caused by the same thing, an incomplete
seed, and each one lower. A fifth correction came from the opposite direction:
the consumer filter excluded `__tests__` and `*.spec.*` but not `e2e/`, so
`apps/desktop/e2e/helpers/mcp-apps-ordinary-admission.ts` was counted as a
production consumer. It is the only consumer outside `packages/agent` of both
`composeRuntimeToolMap` and `createMcpAppOrdinaryToolCallPreparer` and carries
four `@boundaries-ignore` comments saying it deliberately composes the
production pipeline; read literally as a "non-test consumer" it preserves 38
further modules and cancels most of the deletion.

Hence the rule, and its e2e clause. Two independently seeded walks then agreed
on **34 survivors / 66 retirable**, which is why that figure appears as a dated
measurement rather than as the instruction. It is never to be cited as a
standing fact: recompute it, by the rule, at the moment the step runs. The
relocation set in the first step is likewise computed, not fixed at 16.

Nothing else in this ADR changes. Web still stops calling the loop, and the
deletion is still the largest subtraction available.

## Alternatives considered

- **Web becomes a real host client against a hosted host.** The only option that
  gives web parity, and the only one that retires *no additional* engine code —
  the 82-file subtraction depends on web ceasing to call `streamMastraAgent`,
  not on what replaces it. It requires a network transport the protocol does not
  have, an endpoint-schema change, per-user server data roots with a reset
  lifecycle, a host supervisor owning leases outside any request, multi-tenant
  authentication where web has no user accounts, per-user credential custody, a
  CSP change and a runtime that can load native addons. ADR-0012 declined a
  smaller version of this move — "a Mastra server adapter would move ownership
  of auth, CORS, secrets and the desktop loopback lifecycle for no capability
  Brainstrike lacks" — and this version also acquires user data on a server.
  Rejected here as out of scope for an engine retirement, not as wrong forever.
- **Run a host in the browser.** Rejected on feasibility: `better-sqlite3`,
  `secure-fs-native` (which provides the `flock(2)` the lease is built on),
  `windows-job-native`, `@napi-rs/keyring`, `node:net` and `node:worker_threads`
  have no browser equivalents.
- **Leave the Mastra loop in place for web.** Retires nothing. Holds 32.8K lines
  and a pinned `@mastra/core`/`@mastra/memory` pair alive to serve a single-step
  no-tools call, keeps a second loop in the tree against ADR-0012, and leaves
  `mastra-boundary.md` stating something false.
