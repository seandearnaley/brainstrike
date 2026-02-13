---
title: "20250915 120000 Assistant UI Unification Next Dev Handoff"
status: "cold-archive"
date: "2025-09-13"
superseded_by: "none"
---

Date: 2025-09-15
Owner: Core Platform (Brainstrike)
Audience: Next developer/agent (self-contained brief)

Title: Mastra Agent — Assistant‑UI Unification Handoff and Next Steps

TL;DR
- Assistant‑UI is now the only chat UI on web and desktop. ChatPanel has been removed from the codebase and from the right panel. Web assistant‑ui is ON by default.
- Web routes support assistant‑ui data streams plus read-only tools (`web.echo`, `web.searchDocs`, `web.docSummary`) with progress. Desktop continues to support local tools (filesystem.*) and SSE clients.
- Your focus: persistent memory (desktop+web), assistant-ui parity/quality, and guardrails/telemetry. E2E should exercise assistant-ui flows only.

Key Outcomes in This Phase
- Assistant‑UI default ON (web):
  - apps/web/vite.config.mts: `globalThis.__VITE_ASSISTANT_UI__` defaults to `process.env.APP_SHELL_ASSISTANT_UI !== 'false'`.
  - Web uses assistant‑ui by default; override only by setting `APP_SHELL_ASSISTANT_UI=false` (not recommended).
- ChatPanel removed:
  - Code: packages/ui/src/chat-panel/** deleted; exports removed from packages/ui/src/index.ts.
  - Right panel always renders assistant‑ui: packages/app-shell/src/right-panel.tsx.
- Web tool dispatcher (demo):
  - web.echo with progress wired into:
    - apps/web/src/app/api/chat/route.ts (JSON-lines stream)
    - apps/web/src/app/api/assistant/route.ts (assistant‑stream)
    - apps/web/src/assistant-stream-helpers.ts (dev/preview)
- Agent workflow improvements:
  - packages/agent/src/workflows/plan-then-act.ts: `web.echo` is allowed when `runtime.callTool` is provided (no mcpEnabled required). Filesystem tools still require desktop MCP.
- Provider selection:
  - packages/agent/src/index.ts: uses OpenAI streaming when `runtime.apiKey` is present; else uses plan‑then‑act workflow.
- Desktop runtime remains feature‑complete for this phase:
  - Local assistant‑stream server with safeStorage key injection: apps/desktop/src/assistant-server.ts, apps/desktop/src/secrets.ts.
  - MCP: filesystem stdio tools + SSE client; IPC watch/hot‑reload: apps/desktop/src/mcp-clients.ts, apps/desktop/src/mcp-loader.ts, apps/desktop/src/ipc-mcp.ts.
- Docs updated to reflect ChatPanel removal and assistant‑ui default.

- Current Status Snapshot
- UI: Right panel renders AssistantUiPanel (web+desktop). Selectors: container `data-testid="chat-panel"`, viewport `data-testid="assistant-ui-viewport"`.
- Web routes:
  - `/api/chat` (JSON lines stream)
  - `/api/assistant` (assistant‑stream data stream)
- Tools:
  - Desktop: `filesystem.list`, `filesystem.read`, `filesystem.search`, `web.echo` end‑to‑end.
  - Web: `web.echo`, `web.searchDocs`, `web.docSummary` via server dispatcher with progress + validation.
- Tests:
  - Unit/integration suites green across packages.
  - New assistant‑ui E2E spec for web added (does not run by default here as Playwright starts a server).

What To Do Next (Prioritized)
1) Persistent memory
   - Desktop: Add LibSQL/SQLite file under `app.getPath('userData')` and expose a simple memory API to the agent runtime.
     - Files: packages/agent (new memory adapter), apps/desktop (wiring in assistant-server.ts)
   - Web: Introduce server‑backed memory (KV/SQL) used by web routes. No secrets or client‑side storage of sensitive data.
     - Files: apps/web/src/app/api/* routes + packages/agent memory adapter
     - Validation: Unit tests for memory adapter; smoke E2E (send, reload, thread persists).

2) Assistant‑UI E2E parity
   - Expand web E2E to cover Stop/Retry and tool progress under assistant‑ui only (no MCP on web).
   - Files: apps/web/e2e/assistant-ui-panel.test.ts (add a second spec for interactions), apps/web/e2e/assistant-panel-interactions.test.ts
   - Note: Playwright runs headless; do not change playwright.config.ts.

3) SSE tool‑progress bridging (desktop)
   - Ensure `event: tool-progress` from SSE servers is surfaced to the workflow via `opts.onProgress` and shown in assistant‑ui.
   - Files: apps/desktop/src/mcp-clients.ts (already parses; verify forwarding), packages/agent/src/workflows/plan-then-act.ts (already normalizes; ensure sequencing).
   - Tests: apps/desktop/src/__tests__/main/mcp-clients.sse-call.test.ts; add assertions for progress forwarding.

4) Guardrails and telemetry
   - Add zod schemas for inbound/outbound tool I/O (desktop MCP + web‑safe tools separately).
   - Add logging/tracing hooks (provider latency, token counts, tool timing) and surface errors inline with assistant‑ui.
   - Rate limits/backoff; concurrency caps in workflows.
   - Tests: chaos tests for provider timeout and tool failure.

5) Docs & DX
   - README and docs: summarize assistant‑ui unification, web default flag, and how to toggle for rare cases.
   - Remove remaining references that imply ChatPanel is available.
   - Include troubleshooting for safeStorage, assistant‑stream, and MCP config.

How To Run/Verify
- Install: `pnpm install`
- Type-check: `pnpm turbo run type-check --filter ./...`
- Lint/format: `pnpm turbo run lint --filter ./...`
- Build: `pnpm turbo run build --filter ./...`
- Unit/integration: `pnpm turbo run test --filter <pkg>` (examples: @brainstrike/agent, @brainstrike/web, @brainstrike/desktop, @brainstrike/ui)
- Web E2E: `pnpm --filter @brainstrike/web run test:e2e` (headless)
- Assistant env vars: set one of `OPENAI_API_KEY`, `BRAINSTRIKE_OPENAI_API_KEY`, or `BS_OPENAI_API_KEY` before invoking `/api/chat` or `/api/assistant`. Without any of these set the endpoints now return `503 assistant_disabled`.
- Desktop assistant server also respects the same env vars before falling back to safeStorage secrets.
- Assistant UI queries `/api/assistant/status` (web) or `/assistant/status` (desktop) on load; when disabled it renders a callout instead of mounting the panel.

Latest Verification Snapshot (2025-09-15)
- `pnpm --filter @brainstrike/web exec vitest run app/api/chat/__tests__/route.test.ts`
- `pnpm check`

Key Files (by responsibility)
- Assistant‑UI rendering:
  - packages/ui/src/assistant-ui-panel/**
  - packages/app-shell/src/right-panel.tsx
- Web routes (+ demo tool dispatcher):
  - apps/web/src/app/api/chat/route.ts
  - apps/web/src/app/api/assistant/route.ts
  - apps/web/src/assistant-stream-helpers.ts
- Agent core and tools:
  - packages/agent/src/index.ts
  - packages/agent/src/workflows/plan-then-act.ts
  - packages/agent/src/tools/schemas.ts
- Desktop runtime:
  - apps/desktop/src/assistant-server.ts
  - apps/desktop/src/mcp-clients.ts
  - apps/desktop/src/mcp-loader.ts
  - apps/desktop/src/ipc-mcp.ts
  - apps/desktop/src/secrets.ts

Important Decisions from This Phase
- Assistant‑UI is the only supported chat UI in the right panel; ChatPanel is removed.
- Web defaults to assistant‑ui; disabling requires `APP_SHELL_ASSISTANT_UI=false` and is discouraged.
- Web supports `web.echo` tool with progress for assistant‑ui demos; filesystem tools remain desktop‑only under MCP and will not be implemented on web.
- Agent prefers OpenAI streaming when an API key is present; otherwise uses plan‑then‑act.
Non‑Goals (Web)
- No secrets storage or retrieval from web clients.
- No MCP clients or MCP config watcher in web code paths.
- No local runtimes in web (Ollama/LM Studio/WebLLM can be revisited later but are out of scope now).

Open Questions to Confirm Early
- Which web‑safe tools do we want first (search/index/code intel)?
- Memory scope (per project vs global) and retention policy?
- Telemetry destination and sampling (if any)?
- Any additional desktop‑only tools to prioritize?

Acceptance Checklist for Your Changes
- Assistant‑UI continues to render on web+desktop; no regressions.
- Web tool dispatcher supports the agreed set of web‑safe tools with zod validation and tests.
- Persistent memory works in desktop (SQLite/LibSQL) and web (KV/SQL), with tests.
- E2E: assistant‑ui send/stream/stop/retry; tool progress visible and stable.
- Guardrails/telemetry in place with docs updated.

Appendix — Contracts
- Stream chunks (server → client): ` { type: 'text-delta', value } |  { type: 'tool-event', name, status, payload }` where `status ∈  { start, progress, success, error }`.
- Request shape (client → server): ` { messages: AgentMessage[]; data?: RuntimeData }`, with `runtime.callTool(name, params,  { onProgress })` used when available.
