# Agent Hub MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop Brainstrike runs an MCP Streamable-HTTP server so many coding agents (per-worktree or remote) connect, get identities, chat in channels, and read token-budgeted history — surfaced in a Settings category and a color-coded Agent Hub dashboard.

**Architecture:** Pure-domain `packages/agent-hub` (registry + channels + token packing + typed events) consumed by an Electron-main `AgentHubServerManager` (native `node:http` + one `StreamableHTTPServerTransport`/`McpServer` pair per session). IPC + preload bridge (`window.agentHub`) pushes snapshots to the renderer; settings live in a versioned Zustand store + settings category; the dashboard is an app-shell panel behind a new nav item.

**Tech Stack:** TypeScript strict, `@modelcontextprotocol/sdk` ^1.29.0 (`McpServer`, `StreamableHTTPServerTransport`, client transport for tests), zod, Vitest, Zustand persist, Tailwind v4 + `@brainstrike/ui`, `countTokensHeuristic` from `@brainstrike/utils`.

Spec: `docs/superpowers/specs/2026-06-10-agent-hub-mcp-server-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `packages/agent-hub/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` | Package scaffold (model: `packages/token-cache`, minus react/worker bits) |
| `packages/agent-hub/src/types.ts` | `AgentIdentity`, `HubAgent`, `HubMessage`, `ReadMessagesResult`, `HubEventMap`, option types |
| `packages/agent-hub/src/agent-colors.ts` | `AGENT_COLOR_KEYS` (`chart-1`…`chart-5`) + round-robin assignment |
| `packages/agent-hub/src/agent-hub.ts` | `createAgentHub()` — registry, channels, token packing, events, snapshot |
| `packages/agent-hub/src/index.ts` | Public exports |
| `packages/agent-hub/__tests__/agent-hub.test.ts` | Unit tests (registry, messaging, budget, events, snapshot) |
| `apps/desktop/src/agent-hub/agent-hub-config.ts` | Strict runtime config parse/validation (`assertAgentHubConfig`) |
| `apps/desktop/src/agent-hub/agent-hub-tools.ts` | `buildAgentHubMcpServer(hub, sessionKey, contextProvider?)` — MCP tool registration |
| `apps/desktop/src/agent-hub/agent-hub-server-manager.ts` | HTTP server, auth, per-session transports, lifecycle, status |
| `apps/desktop/src/agent-hub/index.ts` | Barrel |
| `apps/desktop/src/__tests__/agent-hub-config.test.ts` | Config validation tests |
| `apps/desktop/src/__tests__/agent-hub-server-manager.test.ts` | Integration tests w/ real MCP client transport |
| `apps/desktop/src/ipc-agent-hub.ts` (+ test) | IPC invoke/event registration via `createDesktopIpcRegistry` |
| `apps/desktop/src/platform/desktop-ipc-channels.ts` | Add `agentHub` channel group |
| `apps/desktop/src/preload.ts` | Expose `window.agentHub` bridge |
| `apps/desktop/src/main.ts` | Construct hub + manager, autostart from persisted settings, quit cleanup |
| `packages/preferences/src/stores/agent-hub-preferences-store.ts` (+ test) | Persisted settings store |
| `packages/preferences/src/settings/agent-hub/index.tsx` (+ test) | `createAgentHubSettingsCategory` |
| `packages/app-shell/src/agent-hub-panel.tsx` (+ test) | Dashboard (connections + chat room) |
| `packages/app-shell/src/navigation.ts`, `types.ts`, `root-layout-content.tsx` | New nav item + content slot |
| `packages/preferences/src/stores/panel-layout-store.ts` | Extend `PanelTab` with `'agent-hub'` |
| `apps/desktop/src/renderer/components/root-layout-content.tsx`, `settings/page-content.tsx` | Desktop composition |
| `apps/web/src/app/...` root layout composition | Web "desktop only" empty state |

## Core types (single source of truth — all later tasks use these exact names)

```ts
// packages/agent-hub/src/types.ts
export type AgentColorKey = 'chart-1' | 'chart-2' | 'chart-3' | 'chart-4' | 'chart-5';
export type AgentStatus = 'online' | 'offline';

export interface RegisterAgentInput {
  name: string;
  sessionKey: string;          // MCP session id (or 'builtin' for Brainstrike)
  program?: string;            // e.g. 'claude-code'
  worktree?: string;           // absolute path
  capabilities?: string[];
}

export interface HubAgent {
  agentId: string;
  sessionKey: string;
  name: string;                // unique; collisions suffixed name-2, name-3…
  color: AgentColorKey;
  status: AgentStatus;
  program?: string;
  worktree?: string;
  capabilities: string[];
  joinedAt: number;            // epoch ms (injected clock)
  lastSeenAt: number;
  tokensSent: number;          // tokens of messages this agent posted
  tokensReceived: number;      // tokens served to this agent via reads
  builtin: boolean;
}

export interface HubMessage {
  id: number;                  // monotonic per hub
  channel: string;             // '#general' default
  fromAgentId: string;
  fromName: string;
  fromColor: AgentColorKey;
  text: string;
  mentions: string[];
  tokenCount: number;
  postedAt: number;
}

export interface ReadMessagesResult {
  messages: HubMessage[];      // chronological
  tokensUsed: number;
  truncated: boolean;          // budget/limit cut off older messages
  latestId: number;            // highest id in channel (0 if empty)
}

export interface HubSnapshot {
  agents: HubAgent[];
  channels: string[];
  recentMessages: HubMessage[];   // last 100 of '#general' + others merged by id
  totalMessages: number;
  totalTokens: number;
}

export interface HubEventMap {
  'agent-joined': HubAgent;
  'agent-left': HubAgent;
  'agent-updated': HubAgent;
  'message-posted': HubMessage;
}

export interface AgentHubOptions {
  maxMessagesPerChannel?: number; // default 1000
  now?: () => number;             // injectable clock for tests
}

export interface AgentHub {
  registerAgent(input: RegisterAgentInput): HubAgent;
  getAgentBySessionKey(sessionKey: string): HubAgent | undefined;
  disconnectAgent(sessionKey: string): void;
  listAgents(): HubAgent[];
  postMessage(input: { sessionKey: string; channel?: string; text: string; mentions?: string[] }): HubMessage;
  readMessages(input: { sessionKey: string; channel?: string; sinceId?: number; maxTokens?: number; limit?: number }): ReadMessagesResult;
  listChannels(): string[];
  getSnapshot(): HubSnapshot;
  on<E extends keyof HubEventMap>(event: E, cb: (payload: HubEventMap[E]) => void): () => void;
}
```

```ts
// apps/desktop/src/agent-hub/agent-hub-config.ts
export interface AgentHubRuntimeConfig {
  enabled: boolean;
  port: number;                  // 1024-65535, default 4519
  bindAddress: '127.0.0.1' | '0.0.0.0';
  authToken: string | null;      // required (non-empty) when bindAddress === '0.0.0.0'
  maxMessagesPerChannel: number; // 10-100000, default 1000
}
export const DEFAULT_AGENT_HUB_CONFIG: AgentHubRuntimeConfig;
export function assertAgentHubConfig(value: unknown): AgentHubRuntimeConfig; // throws AgentHubConfigError
```

```ts
// apps/desktop/src/agent-hub/agent-hub-server-manager.ts
export type AgentHubServerState = 'stopped' | 'running' | 'error';
export interface AgentHubServerStatus {
  state: AgentHubServerState;
  url: string | null;            // http://<bind>:<port>/mcp when running
  connectionCount: number;
  error: string | null;
}
export interface AgentHubServerManager {
  start(): Promise<AgentHubServerStatus>;
  stop(): Promise<void>;
  getStatus(): AgentHubServerStatus;
  applyConfig(config: AgentHubRuntimeConfig): Promise<AgentHubServerStatus>; // restart if running
  onStatusChange(cb: (s: AgentHubServerStatus) => void): () => void;
}
export function createAgentHubServerManager(opts: {
  hub: AgentHub;
  config: AgentHubRuntimeConfig;
  contextProvider?: AgentHubContextProvider;
}): AgentHubServerManager;

export interface AgentHubContextProvider {
  search(input: { query: string; maxTokens: number }): Promise<{ text: string; tokensUsed: number }>;
}
```

MCP tools (registered per session in `agent-hub-tools.ts`): `hub_register`,
`hub_whoami`, `hub_list_agents`, `hub_send_message`, `hub_read_messages`,
plus `context_search` iff `contextProvider` present. All non-register tools
throw `Not registered. Call hub_register first.` for unregistered sessions.

Preload bridge:

```ts
window.agentHub = {
  getStatus(): Promise<AgentHubServerStatus>;
  getSnapshot(): Promise<HubSnapshot>;
  start(): Promise<AgentHubServerStatus>;
  stop(): Promise<AgentHubServerStatus>;
  applyConfig(config: AgentHubRuntimeConfig): Promise<AgentHubServerStatus>;
  postMessage(input: { channel?: string; text: string }): Promise<void>; // posts as builtin participant
  onSnapshot(cb: (snapshot: HubSnapshot) => void): () => void;
  onStatus(cb: (status: AgentHubServerStatus) => void): () => void;
};
```

New IPC channels (`desktop-ipc-channels.ts` group `agentHub`):
`agent-hub:get-status`, `agent-hub:get-snapshot`, `agent-hub:start`,
`agent-hub:stop`, `agent-hub:apply-config`, `agent-hub:post-message`,
events `agent-hub:snapshot`, `agent-hub:status`.

---

### Task 1: Scaffold `packages/agent-hub`

**Files:** Create `packages/agent-hub/{package.json,tsconfig.json,tsup.config.ts,src/index.ts}`

- [ ] Step 1: Copy scaffold style from `packages/token-cache` (`type: module`, tsup build, vitest, `@brainstrike/utils` dep, no react). Name `@brainstrike/agent-hub`, description "Multi-agent MCP hub: registry, channels, token-aware messaging." Export only `.` → `dist/index.js`.
- [ ] Step 2: `src/index.ts` exports nothing yet beyond a placeholder type re-export to compile; verify `pnpm --filter @brainstrike/agent-hub type-check` passes.
- [ ] Step 3: Commit `feat(agent-hub): scaffold package`.

### Task 2: Hub core — registry behavior (TDD)

**Files:** Create `packages/agent-hub/__tests__/agent-hub.test.ts`, `src/types.ts`, `src/agent-colors.ts`, `src/agent-hub.ts`

- [ ] Step 1: Write failing tests:

```ts
import { describe, expect, it } from 'vitest';
import { createAgentHub } from '../src/agent-hub';

const hub = () => createAgentHub({ now: () => 1000 });

describe('registry', () => {
  it('registers an agent with identity, color, and roster placement', () => {
    const h = hub();
    const a = h.registerAgent({ name: 'claude', sessionKey: 's1', program: 'claude-code' });
    expect(a.agentId).toMatch(/[0-9a-f-]{36}/);
    expect(a.color).toBe('chart-1');
    expect(h.listAgents().some((x) => x.agentId === a.agentId)).toBe(true);
  });
  it('suffixes colliding names and cycles colors', () => {
    const h = hub();
    const first = h.registerAgent({ name: 'claude', sessionKey: 's1' });
    const second = h.registerAgent({ name: 'claude', sessionKey: 's2' });
    expect(first.name).toBe('claude');
    expect(second.name).toBe('claude-2');
    expect(second.color).toBe('chart-2');
  });
  it('includes a builtin brainstrike participant', () => {
    const builtin = hub().listAgents().find((a) => a.builtin);
    expect(builtin?.name).toBe('brainstrike');
    expect(builtin?.status).toBe('online');
  });
  it('re-registering the same session replaces the previous identity', () => {
    const h = hub();
    h.registerAgent({ name: 'one', sessionKey: 's1' });
    h.registerAgent({ name: 'two', sessionKey: 's1' });
    const named = h.listAgents().filter((a) => !a.builtin);
    expect(named).toHaveLength(1);
    expect(named[0]?.name).toBe('two');
  });
  it('disconnect marks agent offline and emits agent-left', () => { /* status flips, event payload matches */ });
  it('throws on empty name / unknown session for disconnect', () => { /* AgentHubError */ });
});
```

- [ ] Step 2: Run `pnpm --filter @brainstrike/agent-hub test` — expect FAIL (module missing).
- [ ] Step 3: Implement `types.ts` (above), `agent-colors.ts` (palette array + `colorForIndex(i)`), `agent-hub.ts` registry portion (Map by sessionKey, builtin participant created in factory, `crypto.randomUUID()`, `AgentHubError extends Error`). Disconnected agents stay in roster as `offline` (dashboard history) but their sessionKey mapping is released.
- [ ] Step 4: Tests pass. Commit `feat(agent-hub): agent registry with identity and colors`.

### Task 3: Hub core — messaging + token-aware reads (TDD)

**Files:** same as Task 2

- [ ] Step 1: Failing tests:

```ts
describe('messaging', () => {
  it('posts to #general by default with tokenCount = ceil(len/4)', () => {
    const h = hub();
    h.registerAgent({ name: 'a', sessionKey: 's1' });
    const m = h.postMessage({ sessionKey: 's1', text: 'x'.repeat(20) });
    expect(m.channel).toBe('#general');
    expect(m.tokenCount).toBe(5);
    expect(m.id).toBe(1);
  });
  it('rejects empty text and unregistered senders', () => { /* throws AgentHubError */ });
  it('creates channels on demand and lists them', () => { /* '#general' + '#dev' */ });
  it('evicts oldest beyond maxMessagesPerChannel', () => { /* maxMessagesPerChannel: 2 */ });
});

describe('readMessages token budget', () => {
  it('returns newest messages fitting maxTokens, chronological, truncated=true', () => {
    // three messages of 5 tokens each, maxTokens: 10 -> last two, truncated true, tokensUsed 10
  });
  it('sinceId returns only newer messages and latestId tracks head', () => {});
  it('accumulates tokensReceived on the reading agent and tokensSent on poster', () => {});
});
```

- [ ] Step 2: Run; expect FAIL.
- [ ] Step 3: Implement channels Map<string, HubMessage[]>, monotonic id counter, `countTokensHeuristic` import from `@brainstrike/utils`, newest-first packing loop then reverse, eviction, counters.
- [ ] Step 4: Tests pass. Commit `feat(agent-hub): channels with token-budgeted reads`.

### Task 4: Hub core — events + snapshot (TDD)

- [ ] Step 1: Failing tests: `on('message-posted')` fires with the stored message; `agent-joined`/`agent-left`/`agent-updated` fire; unsubscribe works; `getSnapshot()` returns roster + last ≤100 messages + totals and is JSON-serializable (`structuredClone` round-trip).
- [ ] Step 2: Implement minimal typed emitter (Map<event, Set<cb>>) — no Node `EventEmitter` (keeps package platform-pure).
- [ ] Step 3: Pass. Export everything from `src/index.ts`. `pnpm --filter @brainstrike/agent-hub build && type-check && lint`. Commit `feat(agent-hub): events and dashboard snapshot`.

### Task 5: Desktop config validation (TDD)

**Files:** Create `apps/desktop/src/agent-hub/agent-hub-config.ts`, `apps/desktop/src/__tests__/agent-hub-config.test.ts`

- [ ] Step 1: Failing tests: defaults applied for `{}`? NO — strict: `assertAgentHubConfig` accepts a full unknown object and throws on missing/invalid fields; `DEFAULT_AGENT_HUB_CONFIG` provides defaults explicitly. Cases: bad port (0, 70000, '4519'), bad bindAddress ('localhost'), `0.0.0.0` with `authToken: null` → throws `remote bind requires an auth token`, valid config round-trips.
- [ ] Step 2: Implement with hand-rolled narrowing (matches `resilience-config.ts` style — check that file first and mirror its error type naming).
- [ ] Step 3: Run `pnpm --filter @brainstrike/desktop test -- agent-hub-config`. Commit `feat(desktop): agent hub config validation`.

### Task 6: MCP server manager + tools (TDD, real SDK client)

**Files:** Create `apps/desktop/src/agent-hub/agent-hub-tools.ts`, `agent-hub-server-manager.ts`, `index.ts`, `apps/desktop/src/__tests__/agent-hub-server-manager.test.ts`. Modify `apps/desktop/package.json` (dep `@brainstrike/agent-hub: workspace:*`; add to `prebuild` turbo filter list).

- [ ] Step 1: Failing integration tests using the real client:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function connect(url: string, token?: string) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), token ? {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  } : undefined));
  return client;
}
```

Tests: start on port 0 → status running with url; client lists tools (hub_register, hub_whoami, hub_list_agents, hub_send_message, hub_read_messages; NO context_search without provider); `hub_send_message` before register → tool error containing `hub_register`; two clients register → both visible in `hub_list_agents`; message round-trip between two sessions with `sinceId`/`maxTokens` respected; auth: token configured → request without header gets 401 (client.connect rejects); `0.0.0.0` without token → `start()` rejects; `stop()` → status stopped and hub marks agents offline; `applyConfig` restarts on new port; with a stub `contextProvider`, `context_search` appears and returns provider text.

- [ ] Step 2: Run `pnpm --filter @brainstrike/desktop test -- agent-hub-server-manager` — FAIL.
- [ ] Step 3: Implement:
  - `agent-hub-tools.ts`: `buildAgentHubMcpServer({ hub, getSessionKey, contextProvider })` → `new McpServer({name:'brainstrike-agent-hub', version: app version constant})`, `registerTool` per tool with zod input schemas, results as `{ content: [{ type: 'text', text: JSON.stringify(payload) }] }`, errors via `isError: true` text (SDK convention) — verify with the failing test which shape surfaces to the client and match it.
  - `agent-hub-server-manager.ts`: per-session map `Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>`; on POST without session id → new transport with `sessionIdGenerator: () => randomUUID()`, `onsessioninitialized` stores it; `transport.onclose` → `hub.disconnectAgent(sessionKey)` + map cleanup; GET/DELETE routed to existing transport; non-`/mcp` paths → 404; auth check before routing; `start()` validates config (loopback-vs-token rule via `assertAgentHubConfig`) and listens; track `connectionCount` = map size; status change notifications.
- [ ] Step 4: Tests pass (`--pool=forks` config already set in desktop test script). Commit `feat(desktop): agent hub MCP server manager and tools`.

### Task 7: IPC + preload bridge

**Files:** Create `apps/desktop/src/ipc-agent-hub.ts`, `apps/desktop/src/__tests__/ipc-agent-hub.test.ts`. Modify `apps/desktop/src/platform/desktop-ipc-channels.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/main.ts`.

- [ ] Step 1: Failing test for `registerAgentHubIpcHandlers({ manager, hub, getVisibleWindow })`: registers all invoke channels on a fake registry/ipcMain (mirror an existing `ipc-*.test.ts` to match harness style); `post-message` posts via hub as builtin session; hub `message-posted` event triggers coalesced `webContents.send('agent-hub:snapshot', snapshot)` (use fake timers; coalesce window 100ms).
- [ ] Step 2: Implement with `createDesktopIpcRegistry`, return unregister fn that also unsubscribes hub events.
- [ ] Step 3: Add `agentHub` group to `DESKTOP_IPC_CHANNELS`; preload bridge `contextBridge.exposeInMainWorld('agentHub', …)` following the `embeddingHost` listener-cleanup pattern; extend renderer `desktop-bridge-contract.ts` / global type declarations where `window.embeddingHost` types live.
- [ ] Step 4: Wire `main.ts`: after assistant server start — create hub (`createAgentHub`), manager with `DEFAULT_AGENT_HUB_CONFIG` merged from persisted settings file (the preferences store persists in renderer localStorage, so main cannot read it: instead main starts only when renderer calls `applyConfig`/`start` after hydration, OR honors env `BS_AGENT_HUB_PORT` for tests. Decision: manager constructed eagerly, **not** auto-started; renderer-driven autostart via `applyConfig` once the settings store hydrates with `enabled: true`).
- [ ] Step 5: Tests pass; `pnpm --filter @brainstrike/desktop type-check`. Commit `feat(desktop): agent hub IPC and preload bridge`.

### Task 8: Preferences store (TDD)

**Files:** Create `packages/preferences/src/stores/agent-hub-preferences-store.ts`, test alongside existing store tests.

- [ ] Step 1: Failing tests: defaults (`enabled false`, port 4519, bind 127.0.0.1, token null, max 1000); setters update; persisted partition excludes `hasHydrated`.
- [ ] Step 2: Implement mirroring `assistant-memory-preferences-store.ts` (version 1, browser-json-storage).
- [ ] Step 3: Commit `feat(preferences): agent hub settings store`.

### Task 9: Settings category UI

**Files:** Create `packages/preferences/src/settings/agent-hub/index.tsx` (+ component test). Modify `apps/desktop/src/renderer/components/settings/page-content.tsx` (and web settings composition with `available: false`).

- [ ] Step 1: Failing component test: renders switch + port/bind/token inputs from store; toggling enable calls `window.agentHub.applyConfig` with assembled config (mock `window.agentHub`); shows running URL + connection count from `onStatus`; invalid port shows inline error (config assert performed via prop callback, not silent clamp).
- [ ] Step 2: Implement `createAgentHubSettingsCategory({ available })` (id `agent-hub`, icon `Network` from lucide); unavailable → explanatory empty state (web).
- [ ] Step 3: Register in desktop settings page-content; web passes `available: false`. Commit `feat(settings): agent hub settings category`.

### Task 10: Dashboard panel + navigation

**Files:** Create `packages/app-shell/src/agent-hub-panel.tsx` + `packages/app-shell/src/__tests__/agent-hub-panel.test.tsx` (match existing app-shell test layout). Modify `packages/app-shell/src/navigation.ts`, `types.ts`, `root-layout-content.tsx`, `packages/preferences/src/stores/panel-layout-store.ts` (`PanelTab` + `'agent-hub'`), desktop + web root layout compositions.

- [ ] Step 1: Failing component tests: given a mocked `window.agentHub` snapshot with two agents and three messages — renders agent cards with name/status/`formatTokenCount` totals and color class from `AgentColorKey`; renders chat messages with author chips; composer submit calls `postMessage`; no bridge (web) → "Agent Hub is available in the desktop app" empty state; server stopped → status callout with "Open Settings" affordance.
- [ ] Step 2: Implement panel: `useSyncExternalStore`-style hook `useAgentHubSnapshot()` (subscribe to `onSnapshot`/`onStatus`, initial fetch); two-pane flex layout; agent color dot uses `bg-[hsl(var(--bs-chart-N))]` mapping table; per-message token badge.
- [ ] Step 3: Nav item `{ name: 'Agent Hub', icon: Network, path: '/agent-hub' }`, `NAV_PATH_TO_TAB['/agent-hub'] = 'agent-hub'`, content slot `agentHubPageContent` threaded through desktop + web layouts.
- [ ] Step 4: Tests pass. Commit `feat(app-shell): agent hub dashboard with connections and chat room`.

### Task 11: Renderer autostart + full gates

- [ ] Step 1: Desktop renderer: small effect module (where other desktop-only boot effects run, e.g. near `main.tsx`/root layout) — once agent-hub store hydrates and `enabled`, call `window.agentHub.applyConfig(config)` then `start()`.
- [ ] Step 2: Full verification run (repo bar): `pnpm turbo build --filter=@brainstrike/agent-hub --filter=@brainstrike/desktop --filter=@brainstrike/preferences --filter=@brainstrike/app-shell` + `pnpm -w lint` (or per-package biome) + type-checks + unit tests for the four touched packages, iterate to all-green in one run.
- [ ] Step 3: Commit `feat(desktop): agent hub autostart wiring`.

### Task 12: Manual verification (Chrome DevTools + real MCP client)

- [ ] Step 1: `pnpm --filter @brainstrike/desktop dev:agent-debug` (BRAINSTRIKE_AGENT_DEVTOOLS=1, port 9222).
- [ ] Step 2: Via chrome-devtools MCP: enable hub in Settings, verify status URL; open Agent Hub view.
- [ ] Step 3: Script a real MCP client (node script using SDK client transport) registering two fake agents + chatting; verify dashboard shows color-coded connections + messages live; screenshot for the report.
- [ ] Step 4: Update `AGENTS.md` with an "AGENT HUB (MCP SERVER)" section per the living-document rule. Commit.

## Self-review notes

- Spec coverage: phases 1–5 all mapped (Tasks 1–4 = phase 1; 5–6 = phase 2; 7 = phase 3; 8–9 = phase 4; 10–11 = phase 5; 12 = manual testing). VFS/context provider/assistant seat are spec phases 6–8 (follow-ups, `AgentHubContextProvider` interface landed in Task 6 keeps the seam).
- Main-process settings gap discovered while planning (renderer-persisted store unreadable from main) → resolved via renderer-driven autostart (Task 7/11), documented in spec §3.3 behavior.
- Type names cross-checked across tasks (`HubSnapshot`, `AgentHubServerStatus`, `applyConfig`).
