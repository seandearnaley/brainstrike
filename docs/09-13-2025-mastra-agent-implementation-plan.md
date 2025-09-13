## Mastra Agent Implementation Plan (Desktop + Web)

Date: 2025-09-13
Owner: Core Platform (Brainstrike)
Target apps: `apps/web` (React 19 + shadcn/TW4), `apps/desktop` (Electron)
Shared packages: `packages/agent` (Mastra), `packages/ui` (chat UI), `packages/test-utils`

---

### Goals
- **Multi-step reasoning** chat agent implemented with **Mastra** workflows and tools.
- Runs in both **web** and **desktop** with shared agent core.
- **Electron**: secure secrets without `.env` using `safeStorage` + persistent store behind preload IPC.
- **Desktop-only MCP client**: configurable via JSON; hot-reloadable; safe handling of tokens.
- **UI/UX**: integrate into the Brainstrike IDE layout; likely repurpose the **Props** tab for a chat panel with persisted state.
- **Streaming**: server routes return AI SDK v5 data streams; rich message support.
- Fully validated with build, lint, unit/integration, and e2e; smoke checks at phase ends.

---

### High-level architecture
- `packages/agent/` (Mastra)
  - Agents, Workflows, Tools, optional MCP client wiring
  - Memory pluggable (LibSQL/SQLite desktop; server KV/SQL web)
- `apps/web/`
  - HTTP route that invokes agent and returns **AI SDK v5** data stream
  - UI consumes stream via assistant-ui or AI SDK Elements
- `apps/desktop/`
  - Main process loads secrets via `safeStorage`; invokes agent locally (IPC/HTTP)
  - Preload exposes minimal secure APIs; renderer uses shared chat UI
- `packages/ui/`
  - Chat panel components (shadcn/TW4), message list, composer, tool call renderer
  - State persistence (Zustand + persist) + selectors to avoid over-renders

---

### Progress log
- 2025-09-13:
  - Created `packages/agent` with typed stream API, initial `streamPlanThenAct` workflow, and an in-memory store.
  - Added web route `apps/web/src/app/api/chat/route.ts` streaming JSON lines from `@brainstrike/agent`.
  - Inserted `ChatPanelStub` under the Right Panel Properties tab (`data-testid="chat-panel"`).
  - Lints and unit tests pass for new code.
  - Added zod validation to `/api/chat` for `{ messages, data }` and improved error responses.
  - Implemented shared `ChatPanel` in `@brainstrike/ui` with local persistence and default web transport to `/api/chat`.
  - Wired `ChatPanel` into the Right Panel Props tab, replacing the stub.
  - Added unit tests: route schema/streaming (`apps/web`), ChatPanel streaming (`packages/ui`).
  - Ran type-check, lint/format, build, and fast tests — all green.
  - Added E2E test `apps/web/e2e/assistant-panel.test.ts`; ensured right panel shim is handled; all web E2E now green locally.
  - Desktop Phase 3 in progress: implemented secrets service (`safeStorage` + `electron-store`), IPC handlers, preload bridge, renderer Settings UI for provider keys, and unit tests; added desktop E2E (`secrets-settings.test.ts`).
  - Added local agent IPC (`agent:chat`) with desktop transport in Right Panel; preload bridge unit tests added; E2E `agent-ipc.test.ts` added (launch depends on env).
  - Polished ChatPanel: added Stop/Cancel, Retry, code block rendering with Copy button, and tool-event cards (`data-testid="tool-part"`).
  - Implemented cancellable transports: web transport uses `AbortController`; desktop IPC transport exposes `cancel()` to stop pseudo-stream.
  - Added desktop E2E `assistant-panel-interactions.desktop.test.ts` to exercise Stop, Retry, and code block copy (uses Electron clipboard to verify copy). Desktop E2E still depends on local Electron launch/xvfb.

---

### Phase 1 — Shared agent foundation (cut: stream echo bot)
- [x] Create `packages/agent/`
  - [ ] Add Mastra + provider SDKs (OpenAI/Anthropic/etc.)
  - [ ] Define minimal `chatAgent` with instructions and default model
  - [x] Add one `Workflow` skeleton (plan → act → synthesize) — `packages/agent/src/workflows/plan-then-act.ts`
  - [x] Add streaming export compatible with AI SDK v5 — `toAiSdkStyleStream()`
- [ ] Memory
  - [ ] Desktop: LibSQL/SQLite file path under `app.getPath('userData')`
  - [ ] Web: server-hosted store (KV/SQL); do not expose secrets client-side
  - [x] Temporary in-memory store for dev — `packages/agent/src/memory/in-memory.ts`
- [x] Types
  - [x] Export typed `AgentInput`, `AgentMessage`, `ToolResult` interfaces (no `any`)
- Validation
  - [x] Unit tests for workflow/stream typing and behavior
  - [x] Build/type-check `packages/agent`

---

### Phase 2 — Web integration (cut: chat streams in web)
- [x] Server route in `apps/web` streams from agent
  - [x] Implement POST `/api/chat` → returns newline-delimited JSON chunks
  - [x] Accept `{ messages, data }` with schema validation (zod)
- [ ] UI hookup
  - [x] Add chat panel component from `packages/ui` and wire to `/api/chat`
  - [x] Use AI SDK v5-compatible stream consumption (custom transport) for now
  - [ ] Optional: move to AI SDK Elements/assistant-ui
  - [x] Temporary: `ChatPanelStub` present under Props tab (`packages/app-shell/src/right-panel.tsx`) (replaced)
- [ ] State persistence
  - [x] Persist conversations (local) and restore on reload
  - [x] Keep message list reactive; state preserved with panel mount
- Validation
  - [x] Web unit/integration tests for route and UI streaming
  - [x] E2E: basic send/stream; tab switch persistence
  - [ ] E2E: stop, retry, copy, code block rendering (web) — desktop covered
  - [x] Smoke: tab switch persistence
  - [ ] Smoke: long-stream stability

---

### Phase 3 — Desktop integration (cut: secrets + local agent)
- [ ] Secrets (no .env in renderer)
  - [x] Main: implement `safeStorage` + `electron-store|electron-settings`
  - [x] Preload: `contextIsolation: true`, `nodeIntegration: false`, narrow IPC surface
  - [x] Renderer settings screen to add/edit/delete provider keys
- [ ] Local invocation
  - [x] Option A: IPC invoke agent directly in main
  - [ ] Option B: lightweight local HTTP (127.0.0.1) only from app
- [ ] Local-first runtimes (optional toggles)
  - [ ] Provider select: Cloud / Ollama / LM Studio / WebLLM
  - [ ] Health checks and model availability UI
- Validation
  - [x] Electron unit tests for encryption/decryption (secrets service)
  - [x] Electron unit tests for preload bridge
  - [x] Desktop e2e (headless): settings save/retrieve, send chat, assistant Stop/Retry/Copy flows (tests added; launch depends on env)
  - [ ] Smoke: biometric/OS prompt (if enabled) and restart persistence

---

### Phase 4 — MCP client (desktop-only) (cut: configurable tools)
- [ ] Config schema and location
  - [ ] `mcp.config.json` stored under `app.getPath('userData')/mcp/`
  - [ ] Schema: list of servers with `transport` (stdio|sse), `command|url`, `args`, `headers`, `env`
  - [ ] Support encrypted fields (e.g., `headers.AuthorizationEncrypted`)
- [ ] Loader + hot-reload
  - [ ] File watcher to re-init MCP clients on change
  - [ ] Decrypt sensitive values using `safeStorage`
- [ ] Mastra wiring
  - [ ] Create MCP clients and register as toolsets for agent/workflows
  - [ ] Map MCP tool schemas to agent tool calls with validation
- Validation
  - [ ] Unit: parse/validate config; reconnect on change
  - [ ] Desktop e2e: add filesystem server (stdio), run simple tool call
  - [ ] Smoke: malformed config rollback w/ user-facing error

---

### Phase 5 — Chat panel UX in Brainstrike (cut: replace Props tab)
- [ ] Integrate in IDE layout
  - [ ] Replace or extend the **Props** tab to host chat panel
  - [ ] Maintain state across tab switches; avoid unmount churn
  - [ ] Keyboard navigation, roles, `data-testid` for E2E
- [ ] Rich messages
  - [ ] Support tool call cards, progress, retry per step
  - [ ] Attachments (files/selection) with size/type validation
- [ ] Performance
  - [ ] Virtualize message list for long histories
  - [ ] Memoize selectors; avoid store-wide re-renders
- Validation
  - [ ] UI unit tests for components and reducers/stores
  - [ ] E2E: layout persistence, theme (light/dark/system), accessibility checks

---

### Phase 6 — Guardrails, telemetry, and errors (cut: prod-ready)
- [ ] Input/output schemas (zod) for tools and messages
- [ ] Error handling surfaces (inline toasts, retry flows, fallbacks per step)
- [ ] Logging/tracing hooks (provider latency, token counts, tool timing)
- [ ] Rate limits/backoff; concurrency caps in workflows
- Validation
  - [ ] Chaos tests: tool failure, provider timeout, reconnect
  - [ ] Performance budget: first token < 1.5s (cloud), stream steady

---

### Phase 7 — Documentation & handoff (cut: developer-ready)
- [ ] Update `README.md` sections for agent, web, desktop
- [ ] Create `docs/agent-usage.md` with examples for:
  - [ ] Adding a tool
  - [ ] Adding a workflow step
  - [ ] Wiring an MCP server
  - [ ] Switching providers (Cloud/Ollama/LM Studio/WebLLM)
- [ ] Include troubleshooting: Electron safeStorage, AI SDK streaming, MCP config

---

### Output formats and contracts
- Agent messages (server → client)
  - Text deltas (stream)
  - Structured tool events: `{ type: 'tool', id, name, status, payload }`
  - Final message object with citations/steps taken
- Client requests (client → server)
  - `{ messages: Message[]; data?: { projectId, provider, model, mcpEnabled } }`
- Validation schemas with zod in both directions

---

### Security notes (desktop)
- Never store plaintext API keys; only encrypted blobs
- Preload API is the only surface; validate inputs; no wildcards
- CSP in renderer; disable remote content; sanitize markdown rendering

---

### Version guidance (Sept 2025)
- Mastra: workflows + AI SDK integration for streaming
- Vercel AI SDK v5: data streams, tool streaming, AI Elements or assistant-ui
- Electron: `safeStorage`, `contextIsolation`, preload IPC; avoid `keytar`
- Local runtimes: Ollama/LM Studio; WebLLM (web-only/offline)

---

### Cut lines and validation gates
- Cut A (Phase 1):
  - [x] packages/agent builds; echo-stream works in tests
- Cut B (Phase 2):
  - [x] Web route streams; basic UI sends/receives; e2e green
- Cut C (Phase 3):
  - [ ] Desktop secrets OK; local chat works; e2e green
- Cut D (Phase 4):
  - [ ] MCP client hot-reloads; tool call demo passes e2e
- Cut E (Phase 5–6):
  - [ ] UX polish + guardrails + telemetry; perf budget met

---

### Commands (per monorepo rules)
- Type-check: `pnpm turbo run type-check --filter ./...`
- Lint/format: `pnpm turbo run lint --filter ./...` / `pnpm turbo run format --filter ./...`
- Build: `pnpm turbo run build --filter ./...`
- Tests: `pnpm turbo run test --filter <pkg>`
- E2E: `pnpm run test:e2e` (apps/web)

---

### Open questions / decisions to log
- Default provider set (cloud vs local) per environment?
- Persistence scope for chat threads (per project vs global)?
- Which UI library for chat primitives: assistant-ui vs AI Elements?
- Desktop: IPC vs local HTTP for invoking agent?

---

### Appendix — MCP config example (desktop)
```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"],
      "env": {}
    },
    {
      "name": "web",
      "transport": "sse",
      "url": "http://localhost:7801/sse",
      "headers": {
        "AuthorizationEncrypted": "<base64>"
      }
    }
  ]
}
```

---

### Handoff checklist per phase
- PR description: scope, risks, rollback
- Evidence: build/type/lint logs, unit/integration/e2e results
- Screenshots/GIFs for UI phases; redaction for secrets
- Update this document with resolved decisions and version pins

---

### Repo-specific integration details (from lv-neon-exp and Brainstrike)

- Reference implementation (lv-neon-exp):
  - API route (Mastra-enhanced via AI SDK tools): `apps/web/search-frontend/src/app/api/mastra-assistant/route.ts`
    - Uses `streamText`, `convertToCoreMessages`, `stepCountIs`, `tool(...)`, returns `toUIMessageStreamResponse()`
  - UI patterns: `apps/web/search-frontend/src/components/unified-assistant.tsx`
    - `useChat` with `DefaultChatTransport`, dual-mode switch (AI SDK vs Mastra) and rich tool-part rendering
  - Provider wrapper: `apps/web/search-frontend/src/components/assistant/mastra-assistant-provider.tsx`
- Brainstrike right panel integration points:
  - Right panel tabs (Props/Embed/Search/DB): `packages/app-shell/src/right-panel.tsx`
    - Replace/augment `TabsContent value="properties"` to host chat panel
    - Keep selectors stable (`role="tab"`, inputs like `#rp-search-query`) for e2e
  - Right panel persisted tab store: `packages/app-shell/src/stores/right-panel-store.ts`
    - Tuple/selector patterns; persist `activeTab` under `right-panel.v1`
  - IDE layout injection points: `packages/app-shell/src/root-layout-content.tsx`
    - `rightPanelContent={rightPanelContent}` via `IdeLayout`; panel visibility via `PanelLayoutProvider`
  - E2E persistence patterns: `apps/web/e2e/right-panel-persistence.test.ts`
    - Use `getByRole('tab', { name: 'Search' }).or(getByRole('button', { name: 'Search' }))`
    - Visibility toggles via `getPanelElements(page)` helpers

---

### Concrete file tasks and scaffolding

- `packages/agent/` (new)
  - `src/index.ts`: export `chatAgent`, `streamForAiSdk()` that returns AI SDK v5 data stream
  - `src/workflows/plan-then-act.ts`: Mastra `Workflow` (sequence + branch)
  - `src/mcp/load-mcp-config.ts`: load and decrypt `mcp.config.json`; create MCP clients
  - `src/types.ts`: `AgentMessage`, `ToolEvent`, `RuntimeData` types
  - Tests under `src/__tests__/...`

- `apps/web/`
  - Route: `src/app/api/chat/route.ts`
    - Mirror `lv-neon-exp` `mastra-assistant/route.ts` pattern, but call `@brainstrike/agent` `streamForAiSdk`
    - Validate `{ messages, data }` with zod
  - UI: in `packages/ui`, add `chat-panel/` components and import in right panel’s Props tab

- `apps/desktop/`
  - Main: `src/main/secrets.ts` (`safeStorage` + `electron-store`), IPC handlers `secrets:save/get`
  - Preload: `src/preload/index.ts` exposing `window.secrets.saveKey/getKey`
  - Renderer: settings screen `src/renderer/components/settings/llm-keys.tsx`
  - Local agent invocation: IPC or local HTTP server `src/main/agent-server.ts`

- Right panel integration (`packages/app-shell/src/right-panel.tsx`)
  - Add `ChatPanel` within `TabsContent value="properties"` (or introduce `value="assistant"` if adding a new tab)
  - Ensure state preservation: component remains mounted; follow `navigation-state-preservation` rule

---

### UI selectors and accessibility for E2E

- Floating toggle (if added): `aria-label="Open assistant"` / `data-testid="assistant-open"`
- Chat input: `#assistant-input`
- Send button: `role="button" name="Send"`
- Mode toggle (if multiple backends): `role="button" name="Assistant mode"`, menu `id="assistant-mode-menu"`
- Tool part rows: `data-testid="tool-part" data-tool="searchProducts|smartSearch|..."`
- Properties-tab replacement container: `data-testid="chat-panel"`

---

### Cross-repo patterns to adopt

- AI SDK transport pattern from lv-neon-exp `unified-assistant.tsx` (DefaultChatTransport + tool-part rendering)
- API route structure and `tool(...)` schemas in `mastra-assistant/route.ts`; port to our `packages/agent` tools
- Persist tab and panel layout state using existing Brainstrike stores and `PanelLayoutProvider`

---

### Test additions (files and cases)

- Unit (agent)
  - `packages/agent/src/__tests__/workflow.spec.ts`: step chaining, branch conditions, error paths
  - `packages/agent/src/__tests__/mcp-config.spec.ts`: schema validation, decrypt headers, hot-reload

- Integration (web)
  - `apps/web/src/app/api/chat/__tests__/route.test.ts`: validates zod schemas, tool wiring, error responses

- E2E (web)
  - `apps/web/e2e/assistant-panel.spec.ts`:
    - Show right panel → open Props → verify chat panel visible
    - Send prompt → stream tokens → tool-part rows visible and stabilized
    - Persist state across hide/show and reload (reuse patterns from right-panel-persistence)

- E2E (desktop)
  - `apps/desktop/e2e/assistant-settings.spec.ts`:
    - Save API key via preload; restart app; ensure key is retrievable and agent works
    - Verify no plaintext secrets on disk

---

### Pitfalls and guardrails (repo-specific)

- React compiler/HMR: follow `brainstrike/react-compiler-and-hmr`; don’t change selector tuple arity in stores used by chat panel
- Tailwind v4 shared UI: ensure `@source "./src"` in `packages/ui` and import `styles.css` in app globals
- E2E selectors: always prefer role/label; replicate `or(button)` fallback for Radix tabs
- Panel preservation: do not unmount `RightPanel`; swap via CSS display to preserve chat state

---

### Phase 1 — Validation & completion
- Status: Completed
- Notes:
  - Deps installed; added `@mastra/core`, `@ai-sdk/openai`, `ai` to `@brainstrike/agent`.
  - Implemented `createDevChatAgent()`, `streamPlanThenAct`, and in-memory store.
  - Web route `/api/chat` created and Props-tab `ChatPanelStub` added.
  - TS references fixed (`@brainstrike/agent` paths in root and web tsconfigs; `composite: true` in agent).
  - Lint, type-check, build, and tests all green (`pnpm install`, `pnpm run type-check`, `pnpm run lint-all`, `pnpm run build`, `pnpm run test:fast`).

- Checklist review
  - [x] Package scaffolding and workflow
  - [x] Streaming adapter
  - [x] Temporary memory store
  - [x] Types
  - [x] Validation commands run and passed

---
