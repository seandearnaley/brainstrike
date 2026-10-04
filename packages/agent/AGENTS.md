# Brainstrike Agent Package (`@brainstrike/agent`)

## Purpose and scope

This `agent` package contains the runtime, types and utilities used by the **Brainstrike  
Assistant**. It wraps the Mastra agent core, provider-specific AI SDKs, and the
Model-Context Protocol (MCP) client to provide a fully streamed
assistant experience with deterministic tool calls. The package exposes helpers for  
converting UI messages into agent messages, dispatching local tools, validating  
inputs with `zod` and merging in remote  
tools discovered via MCP. It is **not** a general‑purpose AI framework but the  
glue that powers the IDE’s assistant. All instructions here apply only to this  
package – the root of the mono repo may contain its own AGENTS.md that  
describes high‑level project conventions.

## Project overview

At a high level the package is responsible for:

- Providing **typed message structures** (`AgentMessage`, `AgentMessagePart`, etc.) and  
    helpers (`convertAssistantUiMessages`) to normalise arbitrary UI messages  
    into a canonical agent format. These types ensure that streaming payloads are  
    strongly typed and always serialisable.
    
- Creating an **agent runtime** via `createMastraAgentRuntime()`. This helper
    validates the selected provider, resolves credentials through the shared
    provider key resolver (with explicit keyless local-provider handling),
    merges local tools with MCP tools
    discovered at runtime, sanitises tool IDs and configures the underlying  
    Mastra agent with streaming enabled.
    
- Providing browser-safe documentation-search schemas and executors
    (`searchDocsExecute`, `docSummaryExecute`). These are library exports, not
    entries in the native-tool registry; `web.echo` is intentionally absent.
    
- Providing the **shared retrieval building blocks** (input schemas in
    `src/tools/schemas.ts`, `ContextPacker`, Workspace-Index helpers in
    `src/tools/workspace-index-retrieval.ts`) consumed by the live retrieval,
    query-embedding-space, and hybrid-search tools. The tool implementations
    themselves live in `apps/desktop/src/assistant-server/` (registry-wired
    `run*` functions); a package-local DI copy was dead code and was deleted
    (BST-974, #2105).
    
- Exposing a simple **in‑memory memory store** for development and testing; this  
    can be replaced with a more sophisticated store (e.g. backed by a DB or  
    summarisation service) by swapping the exported `InMemoryMemoryStore`.
    
- Adapting tool progress and results into a uniform `StreamChunk` format so  
    that the UI can render consistent progress indicators and final results.
    

## Set‑up and development

### Install dependencies

This package relies on `pnpm` and the workspace is  
configured as a **TurboRepo**. From the repository root, install all  
dependencies once:

`pnpm install`

### Building and watching

- **Build once**: run `pnpm build` from this package’s directory. It runs  
    `tsup` to compile TypeScript to both ESM and CJS in the `dist` folder and  
    emits type declarations. It also runs `tsc` to ensure type correctness.
    
- **Watch for changes**: run `pnpm dev` to rebuild on file changes.
    

### Testing

We use Vitest for unit tests. To run the test suite  
once, execute:

`pnpm test`

For watch mode use `pnpm test:watch`. To check coverage across all exported  
code, use `pnpm test:coverage`. All tests should pass before you merge; the  
CI checks in `.github/workflows` will block failing builds. To focus on a  
specific test you can use `pnpm vitest run -t "<test name>"` from this package.

### Type checking and linting

TypeScript is configured in **strict mode** – treat all `tsconfig` warnings as  
errors. The repo uses a combination of ESLint and Biome for formatting.  
Before committing, run:

`pnpm lint && pnpm type-check`

Formatting and lint policy is owned by the root Biome/Ultracite and ESLint
configuration. Use the repository commands rather than duplicating style rules
in this package guide.

## Architecture and best practices

### Runtime creation

`createMastraAgentRuntime(options)` is the primary entry point. It accepts  
instructions, model configuration and optional runtime settings (`apiKey`,  
`mcpConfig`, tool overrides, etc.) and returns an object containing a Mastra  
agent and optional MCP client. Hosted providers resolve their configured key
through the runtime/key resolver. Ollama and LM Studio are keyless by default
and resolve to Mastra's first-class OpenAI-compatible model config (`id`,
`/v1` base `url`, and an explicit dummy `apiKey` when auth is disabled); do
not construct them with the OpenAI-specific SDK. The runtime merges local
tools with any tools discovered via MCP, sanitises tool identifiers to avoid
collisions, and exposes a disposable `agent` ready to stream responses.

When adding new configuration fields, make sure values crossing WebSocket or
process boundaries are serializable plain data. `AbortSignal` and class
instances are process-local; represent cancellation or state changes through a
dedicated bridge/protocol rather than putting them in serialized runtime data.

### Background runtime capability

`MastraAgentRuntimeOptions.backgroundTaskScope` is a host-owned resource/thread
scope supplied alongside matching durable memory/storage. It enables native
background delegation with host-owned parent continuation; it is not model-provided configuration. Desktop
memory forwards it through assistant-service. See `docs/agents/assistant-subagents.md`
and `docs/agents/mastra-boundary.md` for ownership, pending decision recovery and
native shutdown qualifications. Explicit root Stop joins native work and cancels
queued/paused tasks; ordinary disposal preserves resumable decisions.

### Tools

Tools are the main extension point. A tool is an object with an `id`, a  
human‑readable `description`, an optional `inputSchema` and an `execute`  
function. Shared schemas/executors live under `src/tools/`; runtime tool
composition lives in `src/mastra/runtime-assembly/tool-pipeline.ts`. Host-only
implementations may live in the owning app package.
When adding a new tool:

1. **Design a clear API**. Prefer small, composable tools over monoliths.  
    Each tool should do one thing well (e.g. search docs, summarise a document,  
    read the filesystem). The description should be concise and written in  
    natural language so that the LLM can choose the tool correctly.
    
2. **Validate inputs**. Define a `zod` schema and assign it to  
    `inputSchema`. Use types like `z.string().min(1)` to avoid empty queries or  
    unreachable paths. All external inputs must be validated before use.
    
3. **Report progress**. Long-running tools should normalize external progress
    payloads with `normalizeProgressPayload()` from
    `src/tools/progress-adapter.ts`. Even
    simple tools can append periodic messages to keep the UI responsive.
    
4. **Stream output**. When possible, stream results incrementally rather than  
    returning one large payload. This keeps memory usage low and makes the  
    assistant feel responsive. Use the `StreamChunk` types to emit `text‑delta`  
    chunks and `tool‑event` chunks for progress and completion.
    
5. **Name sanitation**. Tool IDs are sanitised to contain only `[a‑zA‑Z0‑9_-]`.  
    If two tools sanitise to the same base name, a stable hash suffix is  
    appended automatically. Use descriptive IDs in your source code but be  
    aware that the runtime may rename them internally; the original name is  
    preserved in `runtime.toolNameMap`.
    
6. **Declare the tool once**. A Brainstrike native tool is ONE
    `defineNativeTool({...})` file under
    `packages/assistant-contract/src/native-tools/definitions/` (id, model-facing
    description, registered Zod `inputSchema`, load/risk `defaults`, discovery
    namespace + capability family, `surfaces`, history posture, inspector
    `returns` prose) listed once in `native-tools/index.ts`. Every registry —
    `NATIVE_TOOL_ID`, `TOOL_DESCRIPTIONS`, `NATIVE_TOOL_DEFAULTS`,
    `NATIVE_TOOL_INPUT_SCHEMAS`, discovery namespaces, capability families, the
    web/local partitions, the history allowlists, and the prompt composer's
    model-facing name map — is derived from that list; a missing facet fails at
    definition time (`InvalidNativeToolDefinitionError` /
    `UndeterminableToolRiskError`), never as a stale second copy. The settings
    inspector display (`NATIVE_TOOL_SCHEMAS`) is derived from the definition's
    `inputSchema` too: parameter prose is the schema's `.describe()` text, and
    an optional `display` map on the definition adds inspector-only prose that
    is never sent to the model. Then add the tool's executor entry to the
    exhaustive `NATIVE_TOOL_EXECUTORS` map
    (`apps/desktop/src/assistant-server/native-tool-executors-*.ts`) — a
    definition without an entry is a compile error, and
    `buildDesktopAssistantTools` folds the catalog through that map. The
    catalog's one inline snapshot
    (`packages/assistant-contract/src/__tests__/native-tools.test.ts`) is the
    only place a tool id is listed by hand.

7. **Document your tool**. Update this AGENTS.md to describe any new tools,
    their purpose, limitations and usage. If the tool proxies to an external
    service, document rate limits and visible failure behavior.

### `brainstrike.manageCanvas` tool (schema here, executed in desktop)

Single tool with an `action` discriminated union — `create`, `update`,
`rewrite`, `list` — persisting versioned Canvas documents
(`brainstrike_canvas_versions`, migration 082) that the Canvas surface renders
in the sandboxed CanvasFrame (BST-1173). The Zod schema lives in
`packages/assistant-contract/src/native-tools/schemas/schemas-workspace.ts` (re-exported from
`src/tools/schemas-workspace.ts`) (provider envelope is a strict root object
delegating to the canonical union; root `oneOf` is rejected by the provider
contract). Execution lives in `apps/desktop/src/assistant-server/manage-canvas-tool.ts`.

Purpose and semantics:

- `create {title, html}` mints a canvas (uuidv7) at version 1.
- `update {canvasId, oldString, newString}` requires `oldString` to occur
  EXACTLY once in the latest version; `no_match`/`ambiguous_match` are
  structured failures. Writes a new version row — history is immutable.
- `rewrite {canvasId, html}` replaces content as a new version.
- `list {}` returns summaries only (never `html`), newest-first, capped at 50
  with an explicit `truncated` flag.

Limitations / invariants:

- Desktop-only (web has no tool runtime; excluded from `WebNativeToolId`).
- Mutations are hard-scoped to the calling thread: `threadId` comes from
  runtime memory, never model input, and a cross-thread canvas id resolves to
  the same uniform `not_found` as a nonexistent one (no existence oracle).
- Concurrent updates race on `UNIQUE (canvas_id, version)`; the loser gets a
  structured, retryable `version_conflict`.
- `html`/`oldString`/`newString` are capped at 8 MB (schema-level DoS guard,
  same as workspace-file content fields); titles at 500 chars.
- Risk category is `edit` — durable writes must not be available in plan mode
  or default-allowed under permission enforcement.

### `brainstrike.listWorktrees` / `brainstrike.manageWorktree` tools (schema here, executed in desktop)

Two tools over ONE code path (BST-1392, spec §6.4): both call the SAME
`WorktreeService` the Worktree Map / Mode chip calls, never `git worktree`
directly. `listWorktrees` is read-only; `manageWorktree` creates or archives.
The Zod schemas live in
`packages/assistant-contract/src/native-tools/schemas/schemas-worktrees.ts` (re-exported from
`src/tools/schemas-worktrees.ts`)
(`ListWorktreesInputSchema`, `ManageWorktreeInputSchema` — the latter is a
strict root object with a `superRefine` delegating to a `create`/`archive`
discriminated union, same shape as `manageCanvas`: a raw discriminated union
serializes as a root `oneOf`, rejected by the provider contract), both
entries in `NATIVE_TOOL_INPUT_SCHEMAS` (`src/tools/schemas.ts`). Execution
lives in `apps/desktop/src/assistant-server/worktree-tools.ts`, registered by
`assistant-tools.ts` inside the same local-provider gate `inspectCommandSessions`
occupies (both ids are absent from `LOCAL_DESKTOP_NATIVE_TOOL_IDS`).

Purpose and semantics:

- `listWorktrees {root?}` returns every worktree the inventory ⋈ ledger knows
  about — `branch`, `path`, whether BrainStrike manages it, `usable`, and
  `disabledReason` when it is not. Omit `root` to list every open root;
  otherwise the tool resolves `root` to its repository identity
  (`repoCommonDir`, the realpath'd git-common-dir every worktree of one
  repository shares) and returns every entry sharing it — the primary
  checkout included, regardless of which specific checkout is the granted
  root. Scoping by path equality or by the granted root's own `rootId` is
  deliberately NOT used: managed worktrees are created outside every granted
  root by policy, so only the one checkout that IS the granted root ever
  carries a matching `rootId`, and `root.path` is not realpath'd while
  inventory paths are — both would silently return the wrong (or an empty)
  set for a thread bound to a worktree checkout, the tool's primary scenario.
- `manageWorktree {action: 'create', branch, baseRef?, name?, root?}` creates
  an isolated worktree; `baseRef` defaults to `HEAD`, `name` defaults to the
  branch's last path segment. `{action: 'archive', worktreeId, force?}`
  archives one, always capturing a restorable snapshot first; `force`
  overrides a dirty/unpushed refusal but never an active-run refusal.

Limitations / invariants:

- Desktop-only (excluded from `WebNativeToolId` and `WEB_NATIVE_TOOL_IDS` —
  git worktrees are a filesystem capability the web assistant server has no
  bridge to). Also absent from `LOCAL_DESKTOP_NATIVE_TOOL_IDS`: the built-in
  on-device model's prefill budget cannot afford an approval-gated mutation
  surface it will never see reflected back.
- `listWorktrees` is `read` risk, no approval; `manageWorktree` is `execute`
  risk and approval-gated (spec §6.4) — the model is asking the host to run
  git against the user's checkout. Keeping the read-only listing in its own
  tool is what lets that classification stay strict.
- Provenance (`created_by='agent'`, the originating `run_id`/`thread_id`) is
  bound in `assistant-server.ts`, where the request's run id is in scope —
  never taken from tool input, since provenance the model can set is
  provenance the model can forge.
- A missing capability THROWS a stated reason
  (`"Worktree management is not available in this session."`) rather than
  returning an empty list; an unresolvable `root` throws naming the root
  rather than returning `{ worktrees: [] }` — both would otherwise present
  "the service is not wired" or "root didn't resolve" as the different,
  honest fact "this workspace has no worktrees" (`WorktreeListEntry`'s own
  NO SILENT HIDING contract, spec §13).
- Service refusals (a dirty worktree without `force`, an active run blocking
  archive, a name collision) surface to the model VERBATIM as the thrown
  error's message — never re-worded or swallowed.

### `brainstrike.runPython` tool

Desktop-only deferred tool (BST-1067; Gate B network escalation BST-1070)
that runs assistant-authored Python inside the OS fence, dispatched through
the `CodeExecutor` seam — never a direct spawn. Input is `code`, optional
`timeoutMs`, and optional `allowedDomains` (public hostnames only —
IP literals, `localhost`, and `.local` are rejected at the schema; `[]` and
omitted both mean no network). A domain request opens NOTHING by itself: the
tool suspends with the exact list BEFORE the host is resolved, and only an
explicit per-call allow on the suspension channel (which has no grant
surface) reaches the executor with those domains; anything else denies
(`network_denied`). Writes are confined to a per-call scratch dir that is
deleted afterwards, and a failure to delete it is reported on the result
rather than swallowed; READS are unrestricted, so treat anything the script
reads as sensitive. One timeout budget spans host resolution and execution.
Results are a six-arm discriminated union — `completed` is the only arm
carrying `exitCode`, so a signal kill can never read as exit 0 — and both the
executor cap and the model-facing projection are reported as UTF-8
omitted-byte counts. Execute-risk and approval-gated; a registered suspending
tool, so it is storage-gated and excluded for the built-in local provider.
The host-only `linuxSeccompApplyPath` option pins a physical executable helper
outside ASAR; readiness and each run validate it, and missing helpers fail closed.
Import typed readiness diagnostics from `@brainstrike/agent/code-execution`
without loading the sandbox runtime; keep executor construction lazy.
Full contract and packaged-host example: `docs/agents/code-execution.md` and
`apps/desktop/src/__tests__/fixtures/packaged-python-fence-probe.cjs`.

### `brainstrike.runSkillScript` tool

This desktop-only deferred tool runs a bundled script from the trusted,
enabled Agent Skills scan. Input is a canonical skill name, a `scripts/...`
skill-root-relative path, `node|python3|bash`, structured argv, and an explicit
mounted root/root-relative cwd. The scanner resolves the winning skill and
enforces Claude `allowed-tools: Bash(...)`; the desktop runner rechecks
skill/root containment and workspace-local root ownership before direct argv
spawning. Never replace this with a reconstructed absolute path or a shell
command/heredoc. It is execute-risk and approval-gated; use native workspace
tools for project mutation.
    
### Retrieval evaluation

Before editing repository quality fixtures or comparison adapters, read
`docs/agents/retrieval-quality.md`. Freeze source-reviewed judgments before
retrieval and keep the actual corpus/profile and source streams explicit.

### Retrieval / hybrid-search tools (implemented in desktop, schemas here)

This package owns the retrieval-family **contract surface** — the zod input
schemas (`RetrievalContextInputSchema`, `HybridSearchInputSchema` in
`src/tools/schemas.ts`, both entries in `NATIVE_TOOL_INPUT_SCHEMAS`), the
`ContextPacker`, and the Workspace-Index availability helpers — but NOT the
implementations. The live tools (`brainstrike.queryEmbeddingSpace`,
`brainstrike.hybridSearch`) are the `run*` functions in
`apps/desktop/src/assistant-server/retrieval-tool.ts` and
`hybrid-search-tool.ts`, registered by `assistant-tools.ts`, with behavior
(multi-root scoping, selection snapshots, provider/secrets resolution, output
budgeting) documented in `docs/agents/assistant-providers.md` under
ASSISTANT SEARCH TOOLS.

A package-local dependency-injected copy of both tools existed here until
BST-974 (#2105); it was dead code — zero production callers — and was deleted
rather than back-fed six features of drift. If a browser consumer ever needs
these tools, extract the shared core from the DESKTOP implementation (see the
ticket's divergence map), not from git history of the deleted files.


### Remote tools via MCP

Hosted runs keep MCP schemas deferred. `search_tools` returns at most three
ranked matches without loading them; `load_tool` loads a tool by exact name
(`toolName` or `toolNames[]`); `list_available_tools` enumerates the same
eligible deferred catalog without loading schemas or invoking servers. It
returns 50 entries per page with matching totals, `nextOffset`, and explicit
description truncation. All three controls are reserved when discovery is
installed. Inventory membership is per runtime and inherits all existing
permission/capability gates.

The Model‑Context Protocol allows tool providers to be run as separate  
processes or remote HTTP services and discovered at runtime. You can configure
servers in an `mcp.config.json` adjacent to where `createMastraAgentRuntime` is
invoked. Every server requires a unique `name` and one explicit transport:
`stdio`, `streamable-http`, or legacy `sse`. The transport is never inferred
from the URL and there is no automatic HTTP-to-SSE fallback.

Use Streamable HTTP for new remote servers:

```json
{
  "servers": [
    {
      "transport": "streamable-http",
      "name": "remote-api",
      "url": "https://your-host.example.com/mcp"
    }
  ]
}
```

Use `transport: "sse"` only for a server that explicitly implements the legacy
HTTP+SSE transport, typically at an `/sse` endpoint. `stdio` entries require
`command`; both HTTP variants require `url` and accept the same optional
`headers`. When the agent starts, it attempts to discover tools from all
configured servers with a default timeout of 5 seconds. If discovery times  
out, the agent logs a warning and continues with local tools only.

The protocol-faithful transport clients are exported from the dedicated
`@brainstrike/agent/mcp-client` entrypoint. It uses the official MCP SDK and
constructs only the configured stdio or HTTP transport; it never probes,
rewrites paths, or falls back. Remote URLs must be HTTP(S), must not contain
credentials, and configured headers that conflict with protocol-required
values fail loudly. Connections are lazy and concurrency-safe. A failed initial
connection can be retried with a fresh transport, while `close()` is terminal
and idempotent. For a stateful Streamable HTTP connection, close attempts
session termination before locally closing and still completes local cleanup if
termination fails. An unexpected stdio child exit invalidates that connection
without replaying its in-flight request; only a later operation may reconnect.

Client input is fail-closed. The package provides one capability runtime that
the explicit transports install before connect; it advertises only what a
caller's resolver supplies (desktop production supplies presenter-backed
elicitation, BST-1584) and enables nothing on its own. Modern
`input_required` and legacy pushed requests can share the same handlers, with
automatic fulfillment bounded to eight rounds. Each install returns an owned
lease that aborts active handler work, removes its request/notification
handlers, awaits settlement, and reports exact close counts. Elicitation modes
are advertised separately. URL elicitation requires HTTPS with no embedded
credentials before consent; HTTP exists only behind the explicit loopback
development policy. Accepted form content is host-validated, including the
SDK's four string formats and enum-only multiselect arrays. Deprecated roots,
sampling, and protocol logging remain absent unless a later owner supplies each
complete handler. Review deprecated compatibility for removal on 2027-07-28.

`createMastraAgentRuntime` uses those official-SDK clients for every configured
transport and converts their discovered tools through one shared adapter before
the unchanged namespace/sanitize, output-bound, guard, hook, and permission
pipeline. This transport-owned raw boundary is required for mixed
`structuredContent` plus image/audio `content`: no upstream wrapper may collapse
the complete MCP result before Brainstrike applies persistence and model-output
budgets. Tool progress is emitted as a transient custom stream part; a
progress-writer failure is logged but never overrides the remote tool's primary
result or error.

The dedicated MCP client subpath also preserves resources, resource templates,
prompts, completions, pagination, cache hints, and era-specific subscriptions.
Unsupported lists fail through strict typed SDK capability errors instead of
returning empty arrays. The first cursorless tools/resources/templates/prompts
list on each SDK connection forces a cache refresh; later requests retain normal
SDK cache semantics. Server-feature notification handlers are registered once
per SDK connection, settle subscribers independently, and report every rejection
through the configured diagnostic sink. This transport seam does not itself
claim product support or inject resource or prompt content into model context.

Registered MCP extension requests use the host-owned
`McpClientExtensionRegistry`: both peers must advertise the exact extension,
the complete host implementation and strictly compatible client/server settings
must validate, and params/results cross Standard Schema boundaries. The
registry seals before connection advertisement, so late registration or mutable
settings cannot change a live connection's dispatch surface. Only exact
registered `2026-07-28` contracts outside active core/lifecycle and notification
namespaces may use the owned transport rewrite from a non-colliding internal SDK
method to the canonical wire method. Never generalize that bridge into arbitrary
custom-method dispatch or a core-era bypass.

Tips for MCP integration:

- Keep remote tool processes isolated and sandboxed. Avoid passing  
    unvalidated user input to remote commands.
    
- Do not include secrets directly in `mcp.config.json` – instead, supply  
    credentials via environment variables and read them in the remote process.
    
- Use the MCP hot reload mechanism to 
    rebuild remote clients on changes; this emits progress events so the UI  
    remains responsive.
    

### Host-owned delegated conversation binding (BST-1718)

Persona tools share central artifact settlement after their independent gate and
before their own model projection. Child settlement requires the observed native
execution thread; ordinary ToolsInput functions expose it via Mastra's memory
RequestContext, while ToolAction contexts may expose `agent.threadId`. The shared
execution identity reader supports both vendor contexts and ignores tool input.
Artifact ownership stays on the root resource/thread/run; native execution thread
distinguishes sibling call IDs in migration 129. See the native sibling recovery
test and `docs/agents/assistant-subagents.md`.

`MastraAgentRuntimeOptions.conversationBinding` accepts
`createDelegatedConversationBinding(persist)`. This requires parent/child thread
memory scope and a structured-cloneable configuration snapshot; the host validates
a finite JSON object before storage. The native delegation hook records
observed parent identity in a WeakMap keyed by the actual child RequestContext;
the child input processor awaits the host callback with its actual native
thread/resource and an immutable persona/step-cap snapshot. Missing parent
binding or rejected persistence prevents child model/tool execution. The callback
must validate root ownership and persist through the host database; it never
belongs in RuntimeData or serialized RequestContext entries.

Desktop run-scoped memory now activates this optional port using the host's
persisted owner/root/turn scope. Snapshot resume skips the child input processor.
The `conversationBinding.bindRun` callback is awaited at the first child event of
each attempt/resume leg and authorizes the original persisted invocation.
Bound completion usage retains native parent-run/tool-call and child-thread/resource
identity; the existing desktop writer reconciles cumulative reports after child
publication. The host-only `getDelegatedSystemContext` callback projects original system text.
The root stores only that data in its native RequestContext snapshot; new children
started after approval or question resume receive the same original context.
Callbacks and RuntimeData are never serialized. Non-text metadata is not system
authority. The child checks its context byte budget before inference; native child
MessageList snapshots retain their initial context across approval.
Explorer/Analyst remain read-only; workers require the complete
durable decision host, and nesting remains disabled. The native and production-stream integration suites cover
this seam; see docs/agents/assistant-subagents.md for the full contract.

### Memory and conversation management

The package exports `InMemoryMemoryStore`, which stores conversations keyed by  
conversation ID. It is suitable for development and unit tests but not for  
production: messages are lost on restart and unbounded growth can exhaust  
memory. For production you should implement a durable store (e.g. SQLite,  
browser IndexedDB or a server‑side database). A store should provide  
methods to **append** messages, **retrieve** a conversation and **list**  
recent conversations; optional summarisation can keep token usage under  
control. When persisting to disk, always encrypt user data at rest.

### Streaming and progress

All agent responses are streamed. The `streamMastraAgent()` helper wraps  
Mastra’s `agent.stream()` and converts each Mastra part into one of the ten  
`StreamChunk` variants declared in `src/types.ts` — `text-delta` (plain  
assistant text), `reasoning-delta`, `tool-event` progress/status chunks,  
`run-event` (the durable-persistence discriminator),  
`tool-approval-required`, `tool-suspend-required`, `shell-output`,  
`context-breakdown`, `message-finish` and `finish` markers. A custom UI  
should iterate over the returned `AsyncIterable` and render partials as they  
arrive. Remember to call `runtime.dispose()` when the stream ends to free  
underlying resources.

That `StreamChunk` union — not Mastra's own stream output — is the authoritative  
UI/persistence contract; see R6 in `docs/agents/mastra-boundary.md`.

Progress messages emitted by tools can be normalised with  
`normalizeProgressPayload()`. It accepts diverse shapes—percentages,  
fractions, string statuses—and converts them into a consistent `{ step, percent, note }` structure. Use this to build a progress bar in your UI.

## Security and guardrails

### Core Security Requirements
* **No secrets in client bundles.** Period. Use environment variables, secure desktop storage, or secure injection patterns.
* **Input validation** for all user-provided data using zod schemas before processing.
* **Proper error handling** without information leakage—don't expose internal paths, API keys, or stack traces.
* **Dependencies scanned** for vulnerabilities using `pnpm audit` and automated scanning in CI.

### AI Agent Security
AI agents have access to file systems, external APIs and potentially sensitive data. Follow these rules:

* **Validate all inputs** with zod before they reach your tool logic. Reject invalid paths, excessively long strings and unsupported encodings early.
* **Never echo secrets**. Filter out API keys and tokens from tool outputs.
* **Limit payload sizes**. Cap the number of results returned by search tools and impose maximum byte counts when reading files. If your tool proxies to an external service, enforce request size limits and strip unneeded fields.
* **Sanitize outputs** - ensure tool outputs don't contain executable code or sensitive information.

### MCP Integration Security
Tips for MCP integration:

* Keep remote tool processes isolated and sandboxed. Avoid passing unvalidated user input to remote commands.
* Do not include secrets directly in `mcp.config.json` – instead, supply credentials via environment variables and read them in the remote process.
* Use the MCP hot reload mechanism to rebuild remote clients on changes; this emits progress events so the UI remains responsive.
* **Transport security** - ensure MCP transports use secure protocols and proper authentication.
* **Least privilege** - grant MCP servers only the minimum permissions required.

### Development Security Practices
* **Secret management warnings** - prominently display warnings about hardcoded credentials.
* **Dependency security scanning** - run `pnpm audit` before commits and in CI.
* **Error boundary implementation** - prevent sensitive information from leaking through error messages.
* **Secure defaults** - all security-sensitive features should default to the most secure option.
* Keep secrets out of version control. API keys should be loaded via environment variables or secure desktop storage; never commit them to code or tests.
    
- **Emit progress** updates for long‑running operations so the UI doesn’t  
    appear hung. In the absence of progress updates the assistant may be  
    cancelled by the user.
    
- **Log usage**. When instrumenting the assistant, capture latency, token  
    usage and errors. Use these metrics to tune prompts and identify  
    bottlenecks.
    
- **Failure behavior**. Remote API failure or invalid data must remain visible.
    Return the tool contract's structured error rather than silently switching
    providers, fabricating a result, or throwing an unclassified exception.
    
- **User guidance**. Add helpful messages to your tools’ descriptions so  
    that the language model selects them appropriately and does not attempt to  
    hallucinate unsupported functionality.
    

## Contributing guidelines

Coding agents read this file to select package-local commands and contracts.
Humans should also follow these guidelines when
contributing:

1. **Stay within scope**. Avoid coupling this package to unrelated parts of  
    the monorepo; import only from `@brainstrike/utils`, `@mastra/core` and  
    other explicitly allowed packages. The agent package must remain  
    framework‑agnostic—no React or Electron imports.
    
2. **Write tests first**. Any new feature or bugfix should be accompanied by  
    unit tests in `src/__tests__`. Tests document expected behaviour and  
    prevent regressions. Use Vitest and the existing mocks (e.g. the shared  
    fake-Mastra harness in `src/__tests__/fixtures/mastra-stream-harness.ts`,  
    used by `mastra-streaming.spec.ts` and its three per-module siblings) as  
    examples.
    
3. **Document new tools and runtime options** by updating this file. Include  
    usage examples and edge cases. Tools with side effects must be clearly  
    marked so that agents ask for confirmation.
    
4. **Run the full suite** (`pnpm test`, `pnpm type-check` and `pnpm lint`) before  
    opening a pull request. CI will reject commits that fail.
    
5. **Commit conventions**. Use the format `[agent] <title>` for commit and PR  
    titles[agents.md](https://agents.md/#:~:text=). Describe what changed and why. Explain any  
    breaking changes or behaviour differences in the body.
    
6. **Keep secrets out of version control**. API keys should be loaded via  
    environment variables or secure desktop storage; never commit them to  
    code or tests.

## Recommended reading and future work

- Review the source code in `src` for idiomatic patterns. Functions like  
    `sanitizeTools()`, `mapMastraToolEvent()` and `normalizeProgressPayload()`  
    illustrate how to handle untrusted inputs and convert them into safe  
    structures.
    
This file should evolve alongside the package. Treat it as **living  
documentation**: update it whenever build commands change, new tools are  
added or security considerations evolve. Keeping AGENTS.md accurate will  
ensure that coding agents and human contributors alike can work effectively  
with the Brainstrike Agent package.
