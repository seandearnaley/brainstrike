# Mastra Boundary: Server, Workspace, Browser, RequestContext, Streaming, Observability

Settled rulings for how Brainstrike consumes Mastra. Read this before adding a
`@mastra/*` package, before registering anything new on the `Mastra` instance, and
before moving any Brainstrike-owned surface behind a Mastra one.

Closes the architecture gate that BST-557, BST-558, BST-559, BST-560, and BST-561
each deferred to. The historical audit those tickets cite now lives at
`docs/archive/mastra-agent-system-docs-catch-up-2026-05-29.md` (moved by BST-750,
#1963); it recorded the deferral, never a decision.

Verified against `@mastra/core@1.64.0` and `@mastra/memory@1.28.2` — the only
installed `@mastra/*` packages (`@mastra/schema-compat@1.3.8` is transitive).

## SCOPE AND STATUS

Every ruling below is **ratification of shipped behavior** unless marked NEW. The
audit found no place where current code contradicts the chosen boundary, so
closing this gate required no migration. What was missing was the written record
and its guards — which is why the same decision evaporated across sessions and
was re-deferred four times between 2026-05-30 and 2026-07-24.

| # | Ruling | Kind |
| --- | --- | --- |
| R1 | Mastra is an embedded library runtime; Brainstrike owns all HTTP | ratifies |
| R2 | `@mastra/core` is Node-only; never in a browser bundle | **NEW** |
| R3 | Brainstrike workspace tools are authoritative | ratifies |
| R4 | Browser-driving agents are out of scope | ratifies |
| R5 | `RuntimeData` is authoritative; RequestContext carries Mastra keys only | ratifies |
| R6 | Brainstrike `StreamChunk` is the UI/persistence contract | ratifies + **NEW** unknown-chunk policy |
| R7 | MCP uses the official SDK only | cross-reference to an existing ruling |
| R8 | Brainstrike owns observability; evals are NOT gated on this boundary | ratifies + **corrects** BST-561 |
| R9 | Workflow snapshots are resume state, not app state | ratifies |
| R10 | Prompt Workbench owns prompt/version state | ratifies, with a corrected rationale |

## R1 SERVER BOUNDARY

**Mastra is used as an embedded library runtime. `Config.server` stays unset.
Brainstrike owns every assistant HTTP surface.**

The instance is a registration seam and nothing more —
`packages/agent/src/mastra/agent-runtime.ts:291-296`:

```ts
const mastra = new Mastra({
  agents: { brainstrikeAssistant: agent },
  ...(assistantMessageIdGenerator ? { idGenerator: assistantMessageIdGenerator.generate } : {}),
  logger: false,
  storage,
});
```

No `server`, no `workflows`, no `observability`, no `scorers`. It is constructed
**per request**, and `if (!storage) return {}` (`:285-287`) means hosted web never
constructs one at all. The only method ever called on it is `mastra?.shutdown()`
(`:535`).

Owned by Brainstrike, on both surfaces:

| Concern | Web | Desktop |
| --- | --- | --- |
| Entry | `apps/web/api/assistant.ts:8-24` → `apps/web/src/app/api/assistant/route.ts:29-70` | `startAssistantServer` / `handleAssistantRequest` in `apps/desktop/src/assistant-server.ts` |
| Auth | none per-request; env key only (`assistant-config.ts:3-7`), preview-gated | per-boot capability token, constant-time compare (`assistant-server/auth.ts:12-32`) |
| Origin/CORS | none in code | `hasDisallowedAssistantOrigin` → 403 before CORS headers (`handleAssistantRequest`'s origin gate in `assistant-server.ts` + `hasDisallowedAssistantOrigin` in `assistant-server/cors.ts`) |
| Body parsing | shared parser | shared limit + shared error type |
| Streaming | stateless (`packages/agent/src/stream/data-stream.ts:249`) | resumable sessions + `Last-Event-ID` (session create in `runAssistantTurn`, packages/assistant-service/src/run-turn.ts since BST-972 B3; the desktop transport pumps its Response + `resumeStreamIfAvailable` in `assistant-server/stream-resume.ts`) |
| Persistence | **none, deliberately** (`web-assistant-stream.ts:8-25`) | PGlite run/event/outcome tables (table consts in `assistant-server/run-persistence.ts`) |

### Why not Mastra Server

The historical framing — "adopting Mastra means adopting a generated Hono app" —
is **false at 1.51**. `@mastra/core` ships no HTTP server: its compiled output
contains no `http.createServer`, no `Bun.serve`, and no HTTP `.listen(` (the only
`.listen()` calls are an LSP connection, a voice provider, and an opt-in
Unix-domain-socket pubsub subpath). `Config.server` is inert configuration until a
separate adapter package calls `mastra.setMastraServer(...)`.

Precisely, on the dependency question — the loose phrasing "hono and express are
not dependencies" is wrong in both directions and was corrected in review:

- `hono@4.12.27` **is** in the lockfile, but only via `@vercel/hono` and
  `@hono/node-server` (Vercel CLI tooling). Nothing links it to Mastra.
- `express@5.2.1` **is** resolved inside `@mastra/core`'s peer suffix, via
  `@a2a-js/sdk@0.3.14` — a real dependency of core — where express is an
  **optional** peer (`peerDependenciesMeta.express.optional: true`).

Neither fact weakens R1: an optional peer that core never starts is not an HTTP
surface. But the ruling rests on "core ships no server", not on "express is
absent from the tree", and the guard tests assert the former.

So there was never a cost to *not* adopting it, and adoption today would add a
package while moving ownership of auth, CORS, secrets, and the desktop loopback
lifecycle for no capability Brainstrike lacks. Rejected on cost, not on risk.

**Do not relitigate** without a named capability that requires an adapter.

### First-class subagents: host lifetime decision (BST-1716)

Keep `Agent` plus Brainstrike's owned host services for the first-class
subagent project. The installed native loop already supports recursive
delegation and nested approval/suspension; the executable matrix and planned
limits live in `assistant-subagents.md`. `AgentController` is a beta alternative
session owner, not a prerequisite for those capabilities. Adopting it now would
duplicate existing permission, workspace, run and thread responsibilities.

**Named capability for BST-1723:** a background child must survive the end of a
parent's request and deliver its result to the correct live conversation. The
current per-request Mastra construction/shutdown cannot be treated as that
long-lived host. That ticket must define manager ownership and drain/cancel
behavior, register a durable background-task storage domain, and test recovery
before enabling background dispatch. The current composite store silently
supplies an in-memory background domain; the native regression stores a record
and proves it is absent after reconstructing the wrapper on the same database.
Do not mistake storage availability for durability or adopt the in-memory
substitution in production.

Use `stream(..., { untilIdle: true })` when that integration is ready. The
installed `streamUntilIdle()` declaration is deprecated. Consuming the complete
stream is necessary for continuation output; first-turn aggregate properties
are not a complete background-run transcript. This lifecycle change does not
authorize a Mastra HTTP server, replacement workspace tools, or a second
permission/persistence system.

## R2 NODE-BUILTIN CONTAINMENT (CRITICAL) — NEW

**`@mastra/core` may only be imported where Node builtins exist. It must stay
externalized in every browser bundle.**

`chunk-77JDY5O7.js` — imported by `@mastra/core/agent`, `@mastra/core/mastra`, **and**
`@mastra/core/workspace` — statically imports `fs`, `fs/promises`, `child_process`,
`os`, `path`, `path/posix`, `module`, `url`, `stream`, `stream/web`,
`string_decoder`, and `crypto`. There is no browser-safe entry point.

The guard that already enforces this is `apps/web/vite.config.mts:85`:

```ts
external: ['electron', '@mastra/core', /^@mastra\//]
```

This was previously implicit. It is now a contract: **breaking it is silent at
build time and fails only at runtime in the browser**, which is why it gets a test
rather than a comment.

This constraint — not auth, not CORS — is the real limit on how much Mastra can
absorb. It is also why R3 and R4 resolve the way they do, and it composes with the
existing renderer-only inference invariant in `docs/agents/local-inference.md`:
Mastra sits on the Node side, local inference sits on the renderer side, and
neither crosses.

## R3 WORKSPACE OWNERSHIP

**Brainstrike's native workspace tools remain authoritative. Mastra Workspace
(`createWorkspaceTools`, `LocalFilesystem`, `LocalSandbox`) is rejected.**

Mastra Workspace is genuinely in core at 1.51 — 14 `mastra_workspace_*` tools
(`read_file`, `write_file`, `edit_file`, `list_files`, `delete`, `file_stat`,
`mkdir`, `grep`, `ast_edit`, `execute_command`, `get_process_output`,
`kill_process`, `search`, `index`, `lsp_inspect`). It is rejected on two grounds:

**It has no identity or permission model.** Per-tool config is
`enabled | requireApproval | requireReadBeforeWrite | name | maxOutputTokens`.
Isolation comes only from the provider's `basePath`/`readOnly`. Brainstrike's
`resolveWorkspaceRoot` (`apps/desktop/src/assistant-server/workspace-roots.ts:159`)
resolves a rootId-or-displayName qualifier through a four-step precedence and
**fails loud on eight distinct conditions**: duplicate displayName (`:199-203`),
unknown qualifier (`:204-206`), stale binding (`:209-222`), ambiguity across
multiple roots (`:233-235`), zero roots (`:166-170`), unavailable inventory
(`:143-145`), disconnected root (`:105`), and path escape after realpath on both
sides (`workspace-path-resolution.ts:39-54`). Adopting Mastra Workspace would be a
downgrade in exactly the dimension Brainstrike is strictest.

**It collides with R2.** `@mastra/core/workspace` pulls the Node-builtin chunk.

The 27 desktop tool ids plus 3 skill ids are registered at a single site,
`apps/desktop/src/assistant-server/assistant-tools.ts:150`, where an unknown id in
the preference filter **throws** (`:713-716`) rather than being dropped.

## R4 BROWSER

**Browser-driving agents are not a Brainstrike product capability.**

Core ships only `abstract class MastraBrowser` (`dist/browser/browser.d.ts:296`).
A working implementation requires `@mastra/agent-browser`, `@mastra/stagehand`, or
`@mastra/firecrawl` — none installed — plus a real Chromium either launched
locally or attached over CDP. Not renderer-viable (R2), and it would introduce
browser state, credentials, and consent as new ownership questions.

`webExtract` is a Tavily HTTP API call
(`apps/desktop/src/assistant-server/web-extract-tool.ts:289`), not a driven
browser, and does not change this.

Reopening requires a product decision naming which runtime owns browser state,
credentials, consent, and desktop/web parity.

## R5 REQUEST CONTEXT

**Brainstrike `RuntimeData` is the authoritative request-scoped carrier.
`RequestContext` is limited to Mastra-reserved keys.**

Today exactly two product imports exist:

- `packages/agent/src/mastra/tool-search-runtime.ts` uses
  `MASTRA_THREAD_ID_KEY` to expose Mastra's thread identifier to tool search.
- `packages/agent/src/mastra/thread-title-generation.ts` (moved out of
  `agent-streaming.ts` by BST-1649) creates a fresh, empty `RequestContext` for
  thread-title model resolution and generation. That context remains
  Mastra-only: Brainstrike does not add product or `RuntimeData` fields to it.

The delegated conversation binding adapter uses the child RequestContext only
as a WeakMap key for ephemeral native-call correlation. It adds no entries and
copies no RuntimeData; the host persistence callback travels as a direct runtime
option. Snapshot-resume authorization must read durable host state instead.

Zero of `RuntimeData`'s 43 contract fields
(`packages/assistant-contract/src/runtime-data.ts:216-342`) travel through either
context.

Three field classes, and the third is the reason this ruling is narrow:

1. **Wire-carried** (client → server): ~30 fields; web narrows to 19 forwarded + 8
   accepted-and-ignored, everything else 400s
   (`apps/web/src/server/web-assistant-runtime-schema.ts:164-224`).
2. **Server-injected, never serialized**: `signal`, `steering`, `taskList`,
   `workspaceRoots`, `apiKey`, `callTool`, and every agent-only field in
   `packages/agent/src/types.ts:110`.
3. **Client-supplied then stripped and re-derived server-side**:
   `permissionPolicy`, `hookRunner`, `mcpConfig`, `personaProviderApiKeys`,
   `workspaceSkills` (`prepareRequestSkillsFromDisk` in
   `packages/assistant-service/src/stream-init.ts`), and
   `workspaceRoots` (`stripClientWorkspaceRoots`, same file). The code comment states
   the rule: *"TypeScript types alone are not a request trust boundary."*

**Explicit non-goal:** migrating class 3 into `RequestContext`.
`RequestContext.toJSON()` **silently drops** functions, symbols, and circular refs
rather than throwing, and `RequestContext` is a typed Map with no trust semantics.
Routing stripped-and-re-derived fields through it would move a security boundary
onto a structure that cannot enforce one.

Migrating class 1 is permitted but unmotivated; it buys nothing today.

> Naming note: the Mastra class is `RequestContext`. `RuntimeContext` no longer
> exists — it appears in the package only inside a vendored AI-SDK type stub.
> Tickets and docs saying "RuntimeContext" are naming a symbol that is not a
> Mastra export.

### Memory-model credential boundary

Serialized memory settings may name an observational model target, but that
target is configuration only. `PgliteMastraMemoryOptions` requires a concrete
`LanguageModel` whenever observational memory is enabled and throws before
storage initialization when it is absent. It must never hand Mastra the bare
routing string from settings: doing so would let Mastra resolve credentials
from its own environment or gateway and bypass Brainstrike's env/keychain
contract.

Desktop resolves the provider credential first, then
`createLanguageModelProvider` materializes any model-router descriptor (including
OpenRouter) into a concrete model carrying that explicit credential. Request
state distinguishes `disabled`, `resolved`, and `needs_async_resolution`; only
the last state may consult the desktop credential resolver. An absent credential
after that lookup is a typed failure, never an implicit provider fallback.

## R6 STREAM MAPPER OWNERSHIP

**Brainstrike's typed `StreamChunk` union is the UI and persistence contract.
Mastra output is adapted into it. Mastra's AI SDK UI stream and route layer is
not adopted, regardless of AI SDK version.**

The accepted baseline is AI SDK v7 provider packages (provider v4) with
`@mastra/core` 1.64. Brainstrike adopts their model/provider capabilities while
continuing to own HTTP transport, stream mapping, persistence, and UI contracts.

Two stages, and both are Brainstrike-owned:

1. Mastra chunk → `StreamChunk`: `processMastraStreamPart` in
   `packages/agent/src/mastra/agent-streaming.ts`. Its PURE decoders (part-shape
   readers, tripwire resolution/bounding, provider-error resolution, tool-event
   metadata, OM readers) live in `packages/agent/src/mastra/mastra-chunk-decoding.ts`
   and are unit-tested directly (BST-985). The impure mapping concerns the dispatch
   delegates to are one module each (BST-986), all under `packages/agent/src/mastra/`:

   | Module | Owns |
   | --- | --- |
   | `stream-run-event-chunks.ts` | run-event + finish chunk MINTING (`generateUUID` + `new Date()`); the leaf every other concern depends on |
   | `tool-lifecycle-processors.ts` | the mutable `ToolLifecycleState` record and every mapper that reads or advances it (tool events, delegation/subagent events, terminal + pending-output run events, the finish chunk) |
   | `tool-approval-chunks.ts` | `tool-call-approval` / `tool-call-suspended` PAUSES — well-formed approval, well-formed suspend (registered or not), and the malformed-pause termination |
   | `stream-termination.ts` | abnormal-ending POLICY: provider error, tripwire, stream stall, tool-call-input timeout |

   `agent-streaming.ts` keeps the R6 dispatch itself, the OM data-part mapping, and
   the public entry points — that file is pinned by name in
   `scripts/mastra-stream-chunk-contract.mjs`, so the `ChunkType` import, the
   disposition inventory, `processMastraStreamPart`, and
   `warnForUnrecognizedMastraStreamPart` must not move out of it. The tool-loop /
   stream-option builders moved to `runtime-assembly/stream-options.ts`, and the
   turn/attempt model + three attempt-leg factories moved to `turn-attempts.ts` /
   `attempt-legs.ts` (BST-1649) — none of those three modules are part of the
   pinned contract.

   Provider-error CLASSIFICATION was never part of this file: `../provider-error-metadata.ts`
   owns the bounded `runError` extractor and `mastra-chunk-decoding.ts` owns
   `resolveProviderError` / the diagnostic code + correlation. Likewise the watchdog
   MECHANISM is `../stream/with-inactivity-timeout.ts` + `../stream/with-tool-call-input-timeout.ts`;
   `stream-termination.ts` owns only what a fired watchdog emits.
2. `StreamChunk` → encoded frames: `DataStreamMapper`,
   `packages/agent/src/stream/data-stream-mapper.ts:255` (dispatch `:289-321`).

The mapper is load-bearing for three already-recorded rulings in
`docs/agents/assistant-runtime.md` that adopting Mastra's output would break:

- Run-event deferral across streaming text parts (`:302-306`) — *"never drop them,
  never emit them mid-part."*
- `shell-output` is transient **by design**, and `chunk.type === 'run-event'` is the
  **durable-persistence discriminator** decided at the mapper (`:393-400`).
- The terminal Stop hook must run **before** `message-finish` is yielded
  (`:974-981`).

Transient-vs-durable is a mapper decision. That is the contract.

### Unknown-chunk policy — NEW

Today all three dispatch sites drop silently with no log and no comment:
`agent-streaming.ts` (`processMastraStreamPart`'s `default:` arm),
`data-stream-mapper.ts:318-319`,
`tool-event-mapper.ts:102-103`. This contradicts the project's NO SILENT FALLBACKS
rule, and contradicts the sibling read path in the same subsystem —
`requireRunEventKind()` (`packages/assistant-data/src/assistant-memory-repository.ts:1209-1217`)
**throws** on an unknown run-event kind.

**Ruling:** the mapper must be typed against Mastra's exported `ChunkType` union so
drift is a **compile-time** failure at upgrade, and at runtime an unrecognized chunk
must emit a coded warning plus a diagnostic event while keeping the stream alive.

Deliberately **not** a throw: a Mastra minor release adding a chunk type must fail
in CI, not in a user's live run.

`asMastraStreamPart()` (now `packages/agent/src/mastra/mastra-chunk-decoding.ts`)
still casts to a *local* `MastraStreamPart` interface rather than importing
Mastra's union, so the compiler cannot see drift at all. Fixing that is the
substance of this policy.

Scale of the current gap, re-measured against the 1.64.0
`dist/stream/types.d.ts:1048` (`ChunkType`) for BST-1667:

| Union | Members | Handled |
| --- | --- | --- |
| `AgentChunkType` (`:807`) | 46 | 18 |
| `WorkflowStreamEvent` (`:949`) | 11 | 0 |
| `NetworkChunkType` (`:721`) | 27 | 0 |
| `DataChunkType` (`:714`) | `data-${string}` | 2 Brainstrike-owned |

Members are the `type:` literals of each union; Handled counts the
`'mapped'` entries of `MASTRA_STATIC_CHUNK_DISPOSITIONS` among them. By that
same method the previously installed 1.59.0 dist measures 44 / 18 (the earlier 43 / 17
predates 1.59 and its line references no longer resolved). 1.64 therefore
adds exactly two `AgentChunkType` members, `custom` and `reasoning-file`, and
changes nothing handled: the compile-time guard caught both, as designed, and
each is dispositioned `ignored`.

The static inventory records an explicit `'mapped' | 'ignored'` disposition,
not mere presence. An unhandled dynamic-family member has no disposition and
therefore warns once per type per stream rather than once per chunk. A widened
upstream `string` union is also a type-check failure.

`processMastraStreamPart` is the live untyped Mastra boundary. The exhaustive
`DataStreamMapper.handleChunk` and already-narrowed `mapMastraToolEvent`
defaults are defensive backstops for runtime-unsound callers; their tests use
casts deliberately. All three share the same bounded chunk-type formatter.

`scripts/mastra-stream-chunk-contract.mjs` enforces the type import, the complete
static disposition inventory, the widening assertion, and an AST-verified
coded `logger.warn` on each named dispatch default path (the active Mastra
boundary uses one pinned helper to keep the switch complexity bounded). Its
paired control cases prove a silently-dropping default and a warning moved
elsewhere both fail. The decision is settled here, so it is no longer
architecture-gated.

## R7 MCP TRANSPORT AND CAPABILITIES

**Transport selection is already ruled.** See
`docs/agents/assistant-providers.md:400`, `## MCP TRANSPORT SELECTION (CRITICAL)`:
explicit `stdio` / `streamable-http` / `sse` per server, official
`@modelcontextprotocol/sdk` clients only, and **no** automatic Streamable HTTP → SSE
fallback. That ruling stands unchanged; this section only adds the capability
matrix BST-559 asked for.

`@mastra/mcp` is **not** a dependency — zero hits across every `package.json`, the
lockfile, and `node_modules/.pnpm`. Reintroducing it is rejected: it would create a
second connection lifecycle alongside the SDK clients for no capability the SDK
lacks. The desktop `sse-client.ts` is an 11-line compatibility shim over the
SDK-backed adapter, not a bespoke client (#1593).

| Capability | Status | Ruling |
| --- | --- | --- |
| Tool approval | implemented (`permission-tool-gate.ts:67-86`) | keep; unclassified MCP tools default to risk `mcp`, never `read` |
| Progress | implemented in agent runtime (`mcp-runtime-client.ts:224-242`); plumbed-but-unused in desktop | keep; desktop wiring is optional |
| Custom fetch | seam exists, no production caller (`explicit-http-client.ts:24,144`) | keep the seam |
| Resources / templates / prompts | not implemented | **out of scope** — no product need; these are Brainstrike gaps, not SDK gaps |
| Elicitation | not implemented | **out of scope** — overlaps the existing tool-approval and suspension UIs |
| OAuth | not implemented | **blocked**, not rejected — requires a secrets and redirect/callback boundary that does not exist |

## R8 OBSERVABILITY AND EVALS

**Brainstrike Pino logs, durable run events, the usage ledger, and diagnostic
events remain the observability source of truth. `@mastra/observability` is not
adopted.**

Four stores, contractually separate:

| Store | Scope | Retention |
| --- | --- | --- |
| `brainstrike_assistant_run_events` | run | thread cascade |
| `brainstrike_diagnostic_events` (Flight Recorder P1) | app-wide, warn+ | 30d / 20k rows |
| `brainstrike_assistant_run_usage` | billing fact, no FK | unbounded by design |
| Pino → `brainstrike.log` | process | file rotation |

Run-event metadata is redacted by denial-list at construction *and* at both write
sites (`packages/assistant-contract/src/run-events.ts:104-138`, `:164-214`). The
tool-lifecycle bridge builds metadata from scratch with four keys only
(`mastra-chunk-decoding.ts` `makeToolEventMetadata`, plus the delegation
builder in `tool-lifecycle-processors.ts`), so raw args, results, and error text never reach a
durable row.

Adopting `@mastra/observability` would add a second exporter topology over the same
events with no consumer. Also note a silent-degradation trap: passing a config
*object* to `observability` instead of an `Observability` *instance* logs a warning
and disables observability **entirely**.

### Correction to BST-561 — evals are NOT gated on this boundary

The archived audit's blocking instruction (*"do not add `@mastra/evals`,
observability packages, or scorer registration until the canonical boundary is
decided"*) is **over-broad and now retired**.

`runEvals` and `createScorer` are in **core 1.51** (`dist/evals/run/index.d.ts`,
`dist/evals/base.d.ts:252-261`). They require **no server, no storage, and no
cloud** — storage only upgrades trajectory scorers from message-derived to
trace-derived. Only *prebuilt* scorers need `@mastra/evals`.

Eval adoption may therefore proceed on its own merits (BST-589) without waiting on
anything in this document.

> Docs-ahead-of-package warning: the official `runEvals` docs describe `inputs`,
> `turns`/`EvalTurn`, and `turnResults`. **None exist at 1.51** — `RunEvalsDataItem`
> has only `input`, `groundTruth`, `expectedTrajectory`, `requestContext`,
> `startOptions`. Write against the installed `.d.ts`, not the docs.

## R9 WORKFLOWS AND RUN TIMELINE

**Workflow snapshots are runtime-resume state. The run timeline is Brainstrike
telemetry. Neither replaces the other.**

`mastra_workflow_snapshot` (`packages/agent/src/pglite-mastra-memory/workflows-store.ts:208`)
is written on suspend and read on resume — plus pending-approval discovery
(`suspended-run-discovery.ts`, moved out of `agent-streaming.ts` by BST-1649),
which is still the resume path. Nothing else
reads it: no analytics, no UI, no history view. Mastra's own guidance is to store
references rather than payloads, and `pruneSnapshot` must be pure and JSON-safe
because a snapshot may cross a pubsub boundary.

`Run.timeTravel()` exists (`dist/workflows/workflow.d.ts:655`) but is
**replay-from-a-chosen-step with injected context**, not a read-only history
browser. It is not a run-timeline substitute.

The run timeline is the Brainstrike contract: 31 event kinds in
`packages/assistant-contract/src/run-events.ts:3-35`, persisted by two writers with
byte-identical SQL (`recordDesktopAssistantRunEvent` in
`apps/desktop/src/assistant-server/run-persistence.ts`;
`packages/assistant-data/src/assistant-memory-repository.ts:2449-2502`), read by reload
hydration, the live timeline UI, and the debug bundle.

**Typed suspension UIs are supported and unknown resume schemas must be rejected
visibly.** The transport envelope is already validated and 400s on violation
(`packages/assistant-contract/src/tool-suspend.ts:82-95`). A *semantically* unknown
suspending tool currently renders a generic non-actionable notice
(`assistant-tool-suspend-notice.tsx:463-475`) and leaves the run suspended with no
error surface — that is a gap against this ruling, tracked below.

## R10 PROMPT STATE AND EDITOR

**Prompt Workbench owns user prompt and version state.** PGlite is the only prompt
store; see `docs/agents/workspace-context.md`, `## PROMPT WORKBENCH`. Mastra Editor
is not adopted.

Two corrections to the rationale the tickets carried:

- Mastra Editor is **types only** in core 1.51 — `dist/editor/index.d.ts` exports no
  runtime values. Adoption requires `@mastra/editor`, not installed.
- Editor does **not** imply Mastra Cloud. `source: 'code'` writes versioned JSON
  under `./mastra/editor/`, using git as version history. The "cloud lock-in"
  objection is wrong; rejection rests on Prompt Workbench already owning this
  state, not on hosting.

Scope note: the recorded Prompt Workbench ruling covers the **prompt library's own
records**. Assistant system prompts and workspace instructions are a separate
feature whose source of truth is on-disk `AGENTS.md`/`CLAUDE.md`
(`docs/agents/workspace-context.md`, `## WORKSPACE INSTRUCTIONS CONTEXT`). Do not
conflate them.

## VERIFIED-FALSE PREMISES

Recorded so they are not re-derived. Each was checked against the installed
package or the live tree at `8b6ccb92b`.

| Premise carried by the tickets | Reality |
| --- | --- |
| Adopting Mastra Server means adopting a generated Hono app | Core has zero HTTP code; `hono`/`express` are not runtime deps |
| `RuntimeContext` is the Mastra type to migrate toward | The class is `RequestContext`; `RuntimeContext` is not a Mastra export |
| A bespoke desktop SSE MCP client needs replacing | Removed in #1593; the file is an 11-line shim over the SDK adapter |
| `@mastra/mcp` is present and duplicates a lifecycle | Not a dependency anywhere |
| Stream mapping is missing "cache chunks" | No such chunk type; prompt-cache usage is already on `message-finish.usage` |
| Structured object result is a reachable gap | `object`/`object-result` exist but are unreachable — `structuredOutput` is a rejected option (`runtime-assembly/stream-options.ts`'s `assertNoUnsupportedDirectStreamOptions`, called from `agent-streaming.ts`) |
| Evals are gated on the deployment boundary | `runEvals`/`createScorer` are in core; no server or storage required |
| Mastra Editor requires Mastra Cloud | `source: 'code'` is git-backed JSON |
| A CI eval entrypoint shipped in #1088 | The CLI is wired into **no** workflow; the eval logic is gated via vitest under `unit-shard` instead |
| Workspace/Browser/Editor are all core features | Only Workspace is; Browser needs a provider package, Editor ships types only |

## PAIRED TESTS

Guards for the rulings that are cheap to violate silently. Update this doc and
these tests in the same change.

| Ruling | Guard |
| --- | --- |
| R1 | no `@mastra/{hono,express,fastify,koa,nestjs,deployer,server}` in the lockfile; constructed Mastra config carries no `server`/`observability`/`scorers` key in **any** literal form (`key:`, quoted, or bare shorthand — `storage,` in that object is already shorthand), and no opaque spread that would make the scan unverifiable |
| R2 | **both** browser bundles — `apps/web/vite.config.mts` **and** `apps/desktop/vite.config.mts` (the Electron renderer build, `outDir: 'dist/renderer'`) — keep `@mastra/core` and `/^@mastra\//` in their vite externals |
| R6 | `scripts/mastra-stream-chunk-contract.mjs` requires a complete static `ChunkType` disposition inventory and coded warnings at the Mastra, `StreamChunk`, and tool-event dispatch defaults; runtime tests keep the stream alive while the logger emits each diagnostic |
| R4 | `@mastra/agent-browser` absent from every manifest and the lockfile |
| R7 | `@mastra/mcp` absent from every manifest and the lockfile |
| R8 | *(unguarded by design — R8 permits adding `@mastra/evals` on its own merits, so an absence assertion would encode a constraint this ruling explicitly retires)* |

## RESOLVED CONTRACT MAINTENANCE

BST-909 removed the never-emitted `context.budget`, `context.prepared`, and
`context.selection` kinds from the closed run-event union. The inbound guard
rejects those retired strings, and informational timeline coverage uses the
real `hook.notice` kind instead of legitimizing a fabricated persisted event.
Repository history from their introduction in `33799e0fe` through the contract
move and inbound-guard adoption shows the strings only in the declaration and a
fabricated UI fixture, never in an emitter or persistence write. They therefore
never reached durable run-event rows, so no data migration or backfill is
required; adding one would mutate local-first user data without evidence.

## FOLLOW-UPS

Decided here, implemented separately. None is architecture-gated any longer.

- **Unknown resume schema (R9).** Replace the dead-end notice with visible
  rejection.

Flagged, outside this boundary:
`packages/app-shell/src/hooks/use-assistant-mcp-menu-state.ts:55-57` collapses every
MCP failure to a reasonless `ERROR` via a bare `catch`. (The stale
`@mastra/core@1.50.0` `minimumReleaseAgeExclude` entry this section used to flag
was removed in #2295, and `scripts/verify-minimum-release-age-exclusions.mjs`
now fails `pnpm lint` once any such exclusion ages past 30 days, so this class
cannot recur silently.)

## 1.51 → 1.57 UPGRADE NOTES (2026-08-06/07)

Re-verified on `@mastra/core@1.57.0` + `@mastra/memory@1.26.0`: the R1 no-server
guard (`scripts/__tests__/mastra-boundary-contract.test.mjs`, 6/6) and both
stream-contract guards (`mastra-stream-chunk-contract.mjs`,
`verify-mastra-schema-init-order.mjs`) pass unchanged. Compile-time surface
changes hit and fixed in this range:

- `ToolExecutionContext.observe` became REQUIRED (observability helpers, always
  provided by the runtime) while `createTool`'s execute callback context is
  statically typed as only `{ requestContext }` — `mcp-runtime-client.ts` now
  types its inbound context as the `McpExecuteContext` slice it actually reads.
- `ToolsInput[string]` widened with execute-less members (provider-defined
  tools, web-search placeholders) — property probes for `.execute` must narrow
  with `'execute' in tool` first (`apps/desktop/src/ipc-tools.ts`,
  `capture-on-edit.integration.test.ts`).

**The 1.56 approval rework and the BST-1097 adaptation.** 1.56 made the
framework consume `{approved}` resumes of ANY approval-gated call before the
tool can read them, which killed the old self-raised in-tool Gate A (approve
looped forever re-asking; decline became Mastra's generic denial). Rather than
holding below 1.56, the repo adopted the new idiom (settled with the user,
2026-08-07): run_python's Gate A is now the permission gate's ordinary
`requireApproval` clone (pre-execution approval), its Gate B plain suspension
stays resumable because the suspend-resume transport attaches the
`approved: true` rider Mastra's per-leg re-check demands, declines streamed no
tool result at 1.56/1.57 (the approval card's Declined state owned the UX, like
every other ask tool — **superseded at 1.59, see below**), and the
direct-invocation guard stays in-tool. The old
self-approving registry (`SELF_APPROVING_NATIVE_TOOL_IDS`) is deleted. Full
narrative + test map: docs/dependency-updates-breaking-changes.md (Mastra
section) and docs/agents/code-execution.md (Gate A section). The 15-test
`mastra-tool-suspend-resume.integration.spec.ts` remains the canary for any
future approval-semantics drift.

## 1.57 → 1.59 UPGRADE NOTES (2026-08-15, BST-1282)

R6 did its job: the only compile-time break in this range was the sealed
disposition inventory rejecting one newly-added `ChunkType` member. Measured
diff — **exactly one added, none removed**.

**`tool-output-denied` → disposition `'mapped'` (REQUIRED, not optional).**
Payload `ToolOutputDeniedPayload` = `{toolCallId, toolName, args?,
approval:{id, approved:false, reason?}}`. Mastra emits it on the decline leg of
a `requireApproval` call (mastra #20886) so clients can RESOLVE the pending call
instead of hanging. It is the DECLINE terminal of the same lifecycle
`tool-call-approval` opens, and the tool never runs, so no later
`tool-result`/`tool-error` ever carries that id — `'ignored'` would strand the
renderer's tool part pending forever and leave the durable `tool.started`
unpaired, reproducing the exact hang upstream fixed.

**A decline is TERMINAL but it is NOT an error, and the two must diverge —
settled 2026-08-15 on review, do not collapse them again.** `tool-event-mapper.ts`
decodes the chunk to its OWN `StreamChunkTool` status, `'declined'`, carrying the
shared `DeclinedToolCallResult` envelope (`@brainstrike/assistant-contract/tool-approval`:
`{kind:'declined', message, reason?}`) as its `result`. Routing it through
`status: 'error'` instead settles the call but breaks three things:

| Routed as `'error'` | Why that is wrong |
| --- | --- |
| `handleToolError` records `pendingToolErrorTexts` | that map clears only on a later `text-delta`, so a denial that is the last chunk before `finish` (or a Stop right after it) emits "I couldn't complete the tool action because it failed: The user declined this tool call…" and finalizes the step as errored |
| the frame carries `isError: true` | `isError` is the destructive-chrome switch in `tool-fallback.tsx`; nothing broke |
| the result is a bare error string | strings short-circuit `readResultError (`activity-trace-model.ts`, shared by the card and the trace)`, so the card falls through to a GREEN Completed for a tool that never ran, and `narrowRunPythonDisplayResult` returns `null`, bypassing run_python's own muted declined surface |

`DataStreamMapper.handleToolDeclined` therefore settles the id (`toolCallResult`
+ `settledToolCallIds`) with the envelope and NO error flag, and queues no
visible failure text. `settledResultOverride` (`activity-trace-model.ts`)
reads the envelope and renders the
muted `stopped` treatment — the same one run_python already reserved for a
decline. Same ruling as the BST-558 resume-unsupported terminal (see
docs/agents/assistant-runtime.md, "The tool card is SETTLED").

The DURABLE run event deliberately keeps the `tool.failed` KIND and only
relabels to `Tool call declined`: kind is what `getMatchingFailedKind`,
`collectToolDurations`, and `RUN_LEDGER_AGGREGATION_SQL` close a call out on, and
here the call really is over. That is the OPPOSITE conclusion from
`tool.resume.unsupported` (BST-558) for the opposite reason — that pause stays
suspended and can still emit its real terminal later; this one cannot.

The part is dispatched through `mapToolLifecyclePart`, NOT `mapGenericToolEvent`:
a delegation tool (`agent-<persona>`) can be gated by an explicit global approval
gate, its `tool-call` has already emitted `subagent.started`, and the decline is
that delegation's only terminal — so it emits `subagent.failed`/`'cancelled'`
("Subagent delegation declined") and keeps the "never leave an orphaned
`subagent.started`" rule whole. Mutation-checked paired tests in
`mastra-tool-approval-chunks.spec.ts` (settlement + the silent-continuation case
that proves no false failure text) and `mastra-tool-lifecycle.spec.ts` (the
delegation terminal).

**R1/R2 re-verified.** 1.59 drops `@modelcontextprotocol/sdk` from
`@mastra/core` and adds `@modelcontextprotocol/server@2.0.0`. The new package is
**type-only** in the published dist: it appears exactly once, as `import type
{ ElicitRequest, ElicitResult, ServerContext }` in `dist/tools/types.d.ts:3`,
with zero `require`/`import` of it in any `.js`/`.cjs`. No HTTP surface is
gained, so R1 stands unchanged. Both browser bundles still externalize
`@mastra/core` and `/^@mastra\//`.

### `@mastra/memory` hold at 1.26.0 (BST-1320) — SUPERSEDED BY BST-1667

**Superseded by BST-1667 (2026-09-06):** `@mastra/memory` is now pinned at
1.28.2 alongside `@mastra/core` ^1.64.0. The record below is the 1.26.0/1.26.2
A/B as measured on core 1.59.0 and is kept as the diagnosis of the
observational-memory stall; it no longer describes the installed pin.

**Measured on core 1.64.0 + memory 1.28.2 (2026-09-06, BST-1667):** (1) the
race's SOURCE identified below — core's unawaited post-run `DELETE FROM
mastra_workflow_snapshot` — is gone in core 1.64: `deleteRunSnapshots()` is
awaited before `safeClose(controller)` on every terminal path of the agentic
loop (timeout, failed, non-suspended, success), so that statement can no longer
be in flight when a caller closes after consuming the stream. (2) Mastra >= 1.62
adds `Memory.settled()` ("Resolve once all background work this memory started
has finished… Callers that own the storage connection should await this before
closing it"); in `@mastra/memory` it joins the observational-memory engine's
background observer/reflector work, and
`mastra-memory-persistence.integration.spec.ts` now awaits it in `afterEach`
before `database.close()` — a run without it logged
`[OM] Async buffered reflection failed: Error: PGlite is closed`, the
clean-rejection arm of the same race. (3) The full `packages/agent` unit and
integration lanes ran to completion on this pin with no wedge (integration
245s, 37 files). (4) The hazard is NOT gone in general: forcing the abort seam
in `packages/agent/src/mastra/aborted-turn-persistence.ts` off (`shouldPersist`
false) still wedged the worker, so the seam's awaited `saveMessages` remains a
required join on abort paths, and `MessageHistory`'s abort-time write is not
covered by `settled()`. pglite#1084 and mastra#21617 below remain open upstream.

`@mastra/core` moved to ^1.59.0 here; `@mastra/memory` deliberately did NOT move
with it. **1.26.2 hangs the observational-memory suite forever.** Measured A/B,
both arms on core 1.59.0, only the memory pin changed:

| `@mastra/memory` | `packages/agent` `mastra-memory-persistence.integration.spec.ts` |
| --- | --- |
| **1.26.0** | 19/19 passed, 17.6s, exit 0 |
| 1.26.2 | 16 passed, then stalls forever (killed at 300s) |

Two-test repro (`-t "DIRECT-provider observer|VECTOR retrieval"`): on 1.26.0 both
pass (1155ms + 768ms); on 1.26.2 the first passes and
`completes an observation cycle with VECTOR retrieval + the real OpenAI embedder
wiring` never returns. Neither test hangs when run alone on either version —
consistent with the race described below, since an isolated test issues far less
background traffic, and therefore a cheap falsification test for the whole
mechanism. The test's own `30_000` timeout never fires — the block is not
interruptible by vitest's per-test timer. In CI this burns the whole
`Unit (rest)` job to its 60-minute cancellation.

#### Root cause: a PGlite `close()` race, NOT an OM state leak

The earlier "state leaks across observation cycles" reading, and the
`getObservableMessages` / removed-`blockAfter` lead, are **both refuted**. What
actually happens was instrumented end to end (PGlite statement trace with
`close()` wrapped, plus a CDP pause + CPU profile of the wedged fork):

1. After a run's stream is consumed, `@mastra/core` fires its agentic-loop
   workflow-snapshot cleanup (`DELETE FROM mastra_workflow_snapshot WHERE
   workflow_name = $1 AND run_id = $2`) as **unawaited background work** — the
   caller gets no join point for it.
2. The spec's `afterEach` then calls `await database.close()`.
3. `PGlite.close()` calls `mod._pgl_setPGliteActive(0)` — deactivating the WASM
   backend — **before** it awaits the shutdown protocol and `closeFs()`.
   `_checkReady()` only guards *entry*, so a statement already past that guard
   enters `execProtocolRawSync`'s **synchronous** main loop against a dead
   backend and never returns. Neither the statement nor `close()` ever settles.

**Versions, stated exactly.** The vitest statement trace and CPU profile below
were captured on `@electric-sql/pglite` **0.5.4**, on the BST-1282 branch before
BST-1283 bumped the catalog. This repo now pins **0.5.5**
(`pnpm-workspace.yaml`), so the mechanism was **re-confirmed against 0.5.5**:
`close()` is unchanged in the relevant ordering (`_checkReady` → `#closing` →
close listeners → `_pgl_setPGliteActive(0)` → `await execProtocol(end())` →
`await closeFs()`; 0.5.5's only delta is saving/restoring `exitCode` around
`_emscripten_force_exit(0)`, after deactivation and irrelevant here), and the
Mastra-free repro reproduces on the installed 0.5.5 — drain arm returns in 1ms,
race arm hung indefinitely with neither promise settled. Do not treat the 0.5.4
trace as the only evidence; the pinned engine is affected.

Because the wedge is inside synchronous WASM, the event loop is blocked: no
timer, no per-test timeout, and no unhandled rejection can fire. That is exactly
why the job runs to the CI cap instead of failing.

Statement trace, 1.26.2 (the DELETE and the `close()` that follows it 5ms later
both have a `START` and never an `END`):

```
[…368299] START #356 query: DELETE FROM mastra_workflow_snapshot WHERE …
[…368304] START #357 close
```

`@mastra/memory@1.26.2` does not introduce the hang — it **loses the race**. The
same two tests issue 705 statements on 1.26.2 versus 322 on 1.26.0 (the OM
observer/reflector does more cycles), which pushes the tail of that background
traffic past the teardown boundary. On 1.26.0 the same leaked statements land
*after* `close()` finished and reject cleanly with `Error: PGlite is closed`.

**So 1.26.0 is not safe by construction — it wins a race.** Holding the pin
restores green CI; it does not remove the hazard.

**App reachability — AUDITED by code reading (2026-08-16, BST-1329/BST-1330); not
instrumented.** The wedge needs DB work in flight at the moment a PGlite
`close()` runs. Verdicts, with the evidence in the BST-1329/BST-1330 tickets —
a stronger inference than the earlier "plausible, unverified", but still
inference: nobody has instrumented desktop shutdown or factory reset.

- **Desktop shutdown and factory reset: structurally safe, conditional on one
  invariant.** PGlite lives only in the DB-host utility process; every
  statement is a serially dispatched envelope (`db-host-entry.ts` runs exactly
  one request at a time) and `close()` executes only as the `'close'`
  envelope — a Mastra background statement and the in-host `close()` cannot
  overlap **as long as that dispatch stays strictly serial**; that seriality
  is the invariant this verdict rests on. Independently, `DbHostManager.close()`
  kills the host after a 2s ack race, so an in-host wedge is bounded — the
  main-process event loop is never blocked, which is the proven bound (the
  60-minute CI-shaped wedge would need that kill path to fail too). Note
  `close`/`reset` are *control* requests dispatched even while a transaction
  is open. The one in-host non-envelope statement issuer (the live
  extension's internal refreshes) is drained by BST-1330's awaited
  live-unsubscribe in the `'close'`/`'reset'` handlers, which warns on any
  handle that fails to unsubscribe.
- **The web direct path is where the class is reachable**: web factory reset
  closes with no scheduler join, no submission barrier, and live handles still
  subscribed (its own purge DELETEs trigger refreshes racing `close()`), plus
  the narrow DbProvider prod-unmount-mid-init case — tracked as **BST-1329**.

(Close paths are owned by `docs/agents/database.md`; factory reset is a
cross-cutting invariant in `AGENTS.md`.)

Mastra-free proof of the mechanism — awaiting the statement before `close()`
returns in 1ms; starting the same statement and calling `close()` without
awaiting it hangs both promises forever:

```js
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.query('CREATE TABLE t (workflow_name TEXT, run_id TEXT)');
await db.query("INSERT INTO t VALUES ('agentic-loop', 'run-1')");

// The unawaited background statement, exactly as core leaves it after a run.
const background = db.query('DELETE FROM t WHERE workflow_name = $1 AND run_id = $2', [
  'agentic-loop',
  'run-1',
]);

// await background;   // <- with this line: close() returns in 1ms
await db.close(); //    <- without it: this promise never settles
```

Two things ruled OUT, with evidence:

- `patchThread` — core 1.59 implements it as a wrapper that delegates to
  `updateThread`, so this repo's `PgliteMemoryStore` override is still reached.
- `error: extension "vector" is not available` — the failing
  `CREATE EXTENSION IF NOT EXISTS vector` appears in the statement traces of
  **both** versions (1.26.0 statements #80/#152, 1.26.2 statements #110/#349),
  so it is not version-specific and not the hang. It is pre-existing test
  wiring: the spec's `beforeEach` builds a bare `new PGlite()` with no `vector`
  extension, and only the first test rebuilds the instance with it, so the
  VECTOR test's vector-store init always fails.

  **This is a false green, not a cosmetic wart — tracked as BST-1325.** The test
  is named for vector retrieval and sets `retrievalMode: 'vector'`, yet its
  vector store can never initialize, and the very assertion meant to catch that
  (`expect(failureParts).toEqual([])`, i.e. no `data-om-observation-failed`
  part) does not fire. Its `embeddingRequests` assertion is satisfied by the
  semantic-recall embedder, which needs no pgvector. The test would keep passing
  if the OM vector path broke entirely. It also sits in the blast radius of the
  "every PGlite construction site loads the full engine-extension set"
  invariant (`AGENTS.md`, `docs/agents/database.md`) — it escapes the letter of
  the rule because it runs no migrations, but it is the drift the rule exists to
  catch.

**No clean in-repo fix exists today.** Draining before close needs a join point
Mastra does not expose; a `SELECT 1` flush or a sleep only narrows the window
(silent degradation), and a `Promise.race` timeout cannot fire against a blocked
event loop. The real fixes are upstream, and both are filed:

- [electric-sql/pglite#1084](https://github.com/electric-sql/pglite/issues/1084)
  — `close()` must serialize against in-flight statements, or reject them with
  the existing `PGlite is closing` error, instead of wedging. **This is the one
  that unblocks the bump.**
- [mastra-ai/mastra#21617](https://github.com/mastra-ai/mastra/issues/21617) —
  post-run background DB work needs a join point (the `pendingVectorCleanup` /
  `trackVectorCleanup` handle 1.26.2 added for `deleteThread` is the right
  shape), plus the reflector retry ladder re-running four identical attempts.

Tracked in BST-1320. **Re-test the bump when pglite#1084 lands** — that is the
signal, not a new `@mastra/memory` release. The close-path hazard is mirrored in
`docs/agents/database.md` (PGLITE EXTENSION INVARIANT → "CLOSING a PGlite"), so
it is discoverable from the side that would trip it.

**Security framing, stated precisely — do not overstate this cost.** 1.26.2 is
the only thing that drops `image-size@1.2.1` (`@mastra/memory` is its sole
dependent), which would clear two HIGH advisories (GHSA-w3rx-r6r6-pgpr,
GHSA-5p2g-fcmc-qvqq) and take `pnpm audit --prod` from 31 → 29 findings and
12 → 10 high. Holding at 1.26.0 **defers that improvement; it does not introduce
exposure.** `main` is on 1.26.0 and carries `image-size@1.2.1` today, and this
branch measures the same 31 findings / 12 high as `main`. The advisory fix
arrives when BST-1320 unblocks the bump — it is not something this PR gives up.

Peer compatibility is not a concern: 1.26.0 declares
`"@mastra/core": ">=1.4.1-0 <2.0.0-0"`, which 1.59.0 satisfies, and
`pnpm peers check` reports no `@mastra/*` issues.

**Adopted deliberately later, not here.** `stepResult.rawReason` on
`step-finish`/`finish` preserves the provider's own finish reason instead of
collapsing to `'error'` — a direct upgrade for `stream-termination.ts` and
`provider-error-metadata.ts`, additive, and left as a follow-up. 1.58 also made
streams emit `error` chunks and invoke `onError` when a provider ends
`finishReason: 'error'` with no error payload; the existing `'error'` mapping
(`makeRecoveredProviderErrorTermination`) already covers that path and
`data-stream-stall.spec.ts` / `mastra-streaming.spec.ts` pass unchanged.

**The 1.59 shared-message-id fix does NOT retire the BST-1095 dedupe
processor.** mastra #21185 makes a streamed assistant message carry the same id
as its persisted copy, so a chat UI reconciling a live stream against refetched
history stops double-rendering one reply. BST-1095 is a different defect with
the same smell: `MessageList.add`'s sealed-boundary re-key persists a SECOND
durable row (`createdAt + 1ms`) so the prompt replays every `rs_`/`fc_`/`call_`
reference twice and OpenAI 400s. That re-key is still present verbatim in the
1.59 dist (`dist/message-list-*.js`, the two
`createdAt = new Date(existing.createdAt.getTime() + 1)` sites), and the
processor operates on the PROMPT, so it also protects threads whose twin rows
were persisted by older builds. `openai-duplicate-item-compat.ts` stays.
