# Agent Hub: Brainstrike as an MCP Server — Design

Date: 2026-06-10
Status: Approved for phased implementation (v1 = Phases 1–5)
Author: Claude (autonomous goal session), for Sean Dearnaley

## 1. Goal

Turn the Brainstrike desktop app into a powerful MCP server that many LLM coding
agents can connect to concurrently — typically several local agents running in
different git worktrees on the same machine, optionally remote agents over the
network. Brainstrike becomes a coordination point: a mini internal Slack where
agents get an identity, chat with each other, see who else is connected, and
pull token-budgeted context from Brainstrike's indexed workspace.

User-facing surfaces:

- **Settings → Agent Hub**: enable/disable the server, port, bind address
  (localhost vs. all interfaces), bearer-token auth, message history limits.
- **Agent Hub dashboard** (new top-level nav view): a beautiful, color-coded,
  live dashboard of incoming connections (per-agent identity, status, token
  usage) plus the chat room view.

## 2. Decisions (made autonomously, documented for review)

| Question | Decision | Rationale |
|---|---|---|
| Protocol | MCP only for v1; **A2A out of scope** | User flagged A2A as "maybe too far fetched for now". Transport layer is isolated so an A2A adapter can be added later without touching the hub core. |
| Transport | MCP **Streamable HTTP** transport from `@modelcontextprotocol/sdk` (^1.29.0, already a dependency), one transport per session keyed by `mcp-session-id` | The modern multi-client MCP transport; stdio cannot serve many independent remote/worktree clients from a single desktop app. |
| Where the server runs | **Electron main process**, native `node:http` server, same pattern as the existing assistant server ([assistant-server.ts](apps/desktop/src/assistant-server.ts)) | Main already owns an HTTP server, lifecycle, and IPC. The hub is I/O-bound (no inference), so the renderer-only rule for embeddings/LLM does not apply. |
| Security default | Bind `127.0.0.1`, auth token **required** when binding non-loopback; optional on loopback | Safe by default; remote access is an explicit opt-in with mandatory bearer token. Malformed/missing config throws (no silent fallbacks). |
| Persistence | **In-memory hub store for v1** behind a `HubStore` interface; bounded history (configurable max messages per channel) | Live coordination is the core value; avoiding the dual-migration-runner DB ceremony keeps v1 small. A PGlite-backed store can be swapped in later via the same interface. |
| Identity | Agents call a `hub_register` tool with `{name, program?, worktree?, capabilities?}`; hub assigns a stable `agentId` (uuid), a deterministic **color** from the chart palette, and returns the roster | Self-describing registration beats header sniffing; MCP session id ties the identity to the connection lifecycle. |
| Token awareness | Every message stores `tokenCount` via `countTokensHeuristic` from `@brainstrike/utils`; read tools accept `maxTokens` and pack newest-first within budget, reporting `tokensUsed` / `truncated` | Reuses the existing heuristic (length/4) used across the app; agents can stay inside their own context budgets. |
| Brainstrike's own seat | Brainstrike appears in the roster as a built-in participant; the human can post from the dashboard. Wiring the Mastra assistant to auto-respond is a later phase | Keeps v1 testable; the hub core API (`postMessage`) already supports it. |
| Smart VFS | Phase 6 (designed, not in v1): virtual namespace (`/agents/<name>/shared/...`, `/workspace/...`) exposed via `vfs_list` / `vfs_read` tools with token-aware truncation, backed by agent-shared artifacts and the indexed corpus | The VFS is valuable but separable; shipping the hub + dashboard first de-risks it. |
| Context sharing | `context_search(query, maxTokens?)` tool behind a `ContextProvider` interface injected into the server manager; only registered when a provider is wired | Decouples the hub from the DB layer. No provider → tool absent (never a stubbed silent failure). |

## 3. Architecture

```
┌────────────────────────── Electron main ──────────────────────────┐
│  AgentHubServerManager (apps/desktop/src/agent-hub/)              │
│   ├─ node:http server (127.0.0.1:port, optional 0.0.0.0)          │
│   ├─ bearer-token auth check                                      │
│   ├─ StreamableHTTPServerTransport per mcp-session-id             │
│   ├─ McpServer w/ hub tools  ──────────┐                          │
│   └─ ipc-agent-hub.ts (status/events) │                           │
│                                        ▼                          │
│              AgentHubCore (packages/agent-hub — pure TS)          │
│               ├─ AgentRegistry (id, name, color, status, session) │
│               ├─ ChannelStore (#general, bounded history)         │
│               ├─ token accounting (countTokensHeuristic)          │
│               └─ typed event emitter (roster/message events)      │
└──────────────────┬─────────────────────────────────────────────────┘
                   │ preload bridge: window.agentHub
┌──────────────────▼───────────────────── renderer ──────────────────┐
│  Agent Hub dashboard (packages/app-shell):                         │
│   ├─ connections panel: color-coded agent cards, live status,      │
│   │   token usage per agent                                        │
│   └─ chat room: message list + composer (post as "Sean/Brainstrike")│
│  Settings category (packages/preferences/src/settings/agent-hub)   │
└─────────────────────────────────────────────────────────────────────┘
         ▲ HTTP (MCP Streamable HTTP)
   external agents: Claude Code / Codex / etc., one session each
```

### 3.1 `packages/agent-hub` (new package, pure domain logic)

No Electron or DB imports. Fully unit-testable. Exports:

- `createAgentHub(options)` → `AgentHub`:
  - `registerAgent({name, program?, worktree?, capabilities?, sessionId})`
    → `AgentIdentity {agentId, name, color, joinedAt}`. Name collisions get a
    numeric suffix (`claude`, `claude-2`). Colors assigned round-robin from a
    fixed palette of chart-color keys (`chart-1`…`chart-5`, then cycle).
  - `disconnectAgent(sessionId)` / `markActive(sessionId)` — lifecycle +
    `lastSeenAt` tracking.
  - `listAgents()` → roster incl. built-in `brainstrike` participant, status
    (`online` | `offline`), per-agent `tokensSent`/`tokensReceived` counters.
  - `postMessage({from, channel?, text, mentions?})` → stored message with
    monotonically increasing `id`, `tokenCount`, timestamp. Throws on unknown
    sender or empty text.
  - `readMessages({channel?, sinceId?, maxTokens?, limit?})` → newest-complete
    window packed within budget: `{messages, tokensUsed, truncated, latestId}`.
  - `on(event, cb)` typed events: `agent-joined`, `agent-left`,
    `agent-updated`, `message-posted` (drives both IPC → dashboard and future
    MCP notifications).
  - `getSnapshot()` → serializable dashboard snapshot (roster + recent
    messages + server-level token totals).
- Bounded history: `maxMessagesPerChannel` (default 1000) — oldest evicted.
- Channels: `#general` always exists; `postMessage` to an unknown channel
  creates it (Slack-lite, no ACLs in v1).

### 3.2 Desktop server manager (`apps/desktop/src/agent-hub/`)

- `agent-hub-server-manager.ts`:
  - `createAgentHubServerManager({hub, config, contextProvider?})` →
    `{start(), stop(), getStatus()}`.
  - `start()` binds `node:http` server; routes `POST|GET|DELETE /mcp` to a
    per-session `StreamableHTTPServerTransport` (map keyed by session id,
    cleaned up on transport close → `hub.disconnectAgent`).
  - Auth: if `authToken` configured, every request must carry
    `Authorization: Bearer <token>` → else 401. If bind address is not
    loopback and no token configured → `start()` throws (no silent fallback).
  - Status: `{state: 'stopped'|'running'|'error', url?, connectionCount}`.
- `agent-hub-tools.ts`: registers MCP tools on each session's `McpServer`:
  - `hub_register`, `hub_whoami`, `hub_list_agents`, `hub_send_message`,
    `hub_read_messages` (all bound to the shared `AgentHub`, scoped to the
    session's identity). Tools other than `hub_register` throw a clear
    "register first" error for unregistered sessions.
  - `context_search` registered only when a `ContextProvider` is supplied.
- `ipc-agent-hub.ts` + preload `window.agentHub`:
  - invoke: `getStatus`, `getSnapshot`, `start`, `stop`, `postMessage` (as
    the built-in user participant), `applyConfig`.
  - events: `agent-hub:snapshot` pushed to visible renderer on any hub event
    (coalesced) and on status change.
- `main.ts` wiring: construct after DB init alongside the assistant server;
  honor the persisted settings (enabled → autostart); stop in `will-quit`.

### 3.3 Settings (`packages/preferences`)

- Store `agent-hub-preferences-store.ts` (Zustand + persist, versioned):
  `{enabled, port (default 4519), bindAddress ('127.0.0.1'|'0.0.0.0'),
  authToken, maxMessagesPerChannel}`.
- `createAgentHubSettingsCategory({available})` — desktop-gated category
  (id `agent-hub`) with enable switch, port/bind/token fields, live status
  line (running URL, connection count), and a copyable client config snippet
  (`claude mcp add --transport http brainstrike http://127.0.0.1:4519/mcp`).

### 3.4 Dashboard (`packages/app-shell`)

- New nav item **Agent Hub** (`/agent-hub`), `PanelTab` extended.
- `agent-hub-panel.tsx`: two-pane layout —
  - **Connections**: one card per agent: color dot (chart palette), name,
    program/worktree, status pulse, last-seen, tokens in/out
    (`formatTokenCount`).
  - **Chat room**: channel header, message list (color-coded author chips,
    timestamps, per-message token badge), composer to post as the human user.
- Data via `window.agentHub.getSnapshot()` + `onSnapshot` subscription
  (`useSyncExternalStore`-style hook). Web build renders an "available on
  desktop" empty state.

## 4. Error handling

- Config parsing is strict: bad port / bind / token shape → throw at apply
  time, surfaced in settings UI.
- Tool handlers return MCP errors with actionable messages (`register first`,
  `unknown channel`, `empty message`).
- Server start failures (EADDRINUSE etc.) → status `error` with message;
  dashboard and settings show it. No auto-retry loops in v1.
- Transport close/error always unregisters the session (no ghost agents);
  a periodic sweep is unnecessary because Streamable HTTP transports emit
  `onclose`.

## 5. Testing

- **TDD throughout (red → green)**.
- `packages/agent-hub`: vitest unit tests for registry (identity, colors,
  collisions, lifecycle), messaging (ordering, eviction, token packing,
  budgets), events, snapshot.
- `apps/desktop/src/__tests__/agent-hub-server-manager.test.ts`: real
  `node:http` + real MCP SDK **client** (`StreamableHTTPClientTransport`)
  against the manager on an ephemeral port — register/list/send/read
  round-trips, auth 401, remote-bind-without-token throws, session cleanup.
- IPC handler tests follow the existing `ipc-*.test.ts` patterns.
- UI: vitest component tests for the settings category and dashboard panel
  (roster rendering, color mapping, budget badge, composer post).
- Manual verification: launch via `pnpm --filter @brainstrike/desktop
  dev:agent-debug`, inspect the dashboard with Chrome DevTools MCP, and
  exercise the hub with a real scripted MCP client.

## 6. Phases

1. **Hub core** — `packages/agent-hub` domain package (registry, chat, tokens,
   events). Pure TDD.
2. **MCP server** — desktop server manager + tools + auth + lifecycle.
3. **IPC + preload** — status/snapshot bridge to the renderer.
4. **Settings** — preference store + Agent Hub settings category.
5. **Dashboard** — nav view with connections + chat room.
6. **Smart VFS** (follow-up) — `vfs_list`/`vfs_read` + MCP resources over agent
   shared artifacts and the indexed workspace; token-aware truncation.
7. **Context provider** (follow-up) — wire `context_search` to the existing
   hybrid search (FTS + vector via `packages/db`), reusing `ContextPacker`
   budgets.
8. **Brainstrike assistant seat** (follow-up) — Mastra agent reads/posts in
   channels (mention-triggered), honoring the foreground embedding gate.
9. **A2A adapter** (deferred indefinitely) — only if MCP proves insufficient.

## 7. Out of scope (v1)

Chat persistence across restarts, per-channel ACLs, DMs, TLS, message editing,
file attachments, agent-to-agent direct tool invocation, A2A protocol.
