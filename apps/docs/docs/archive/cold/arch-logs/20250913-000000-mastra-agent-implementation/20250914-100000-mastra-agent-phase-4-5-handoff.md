---
title: "20250914 100000 Mastra Agent Phase 4 5 Handoff"
status: "cold-archive"
date: "2025-09-13"
superseded_by: "none"
---

Mastra Agent Handoff (Phase 4b → Phase 5)

Owner: Core Platform (Brainstrike)
Target: apps/web (Vite), apps/desktop (Electron), packages/agent, packages/ui, packages/app-shell
Audience: LLM coding agents or contractors with partial context
Goal: Continue MCP tool wiring (SSE) and polish Chat Panel UX with guardrails
Current Status

Phase 1: Complete (agent scaffolding, plan-then-act, typed stream)
Phase 2: Complete (web route streaming, ChatPanel integration, headless E2E)
Phase 3: Functionally complete (desktop secrets, IPC, settings UI, IPC chat; unit + E2E pass locally)
Phase 4: In progress
Config + loader + preload IPC: done
Clients: stdio filesystem tool implemented; SSE client scaffolded with minimal POST call path
Agent runtime: callTool support + zod validation; “list files [in &lt;path&gt;]” and “echo …” tool steps wired
UI: tool cards render filesystem.list and web.echo payloads; Settings shows MCP config status card
Tests: agent + desktop units pass; desktop MCP E2E exists but CI-skipped due to Electron/Playwright launch flag
Key Decisions

Desktop transport: IPC to main with pseudo-stream in renderer; Stop is cancel via iterator.cancel
Dynamic import: Desktop main uses eval-based import('@brainstrike/agent') and types it as any to avoid TS/bundler coupling
MCP config: Stored at app.getPath('userData')/mcp/mcp.config.json; hot-reloaded; encrypted headers/env supported via safeStorage; dev fallback base64
SSE client convention (temporary): Derive base from &lt;url&gt;/sse and POST tool calls to &lt;base&gt;/call with `{ tool, params }`; header forwarding supported; override call path via MCP_SSE_CALL_PATH
CI: Desktop MCP E2E test is skipped in CI (Electron 38 + Playwright 1.54.2 passes --remote-debugging-port=0 which Electron rejects). E2E runs locally or xvfb.
TypeScript strictness: exactOptionalPropertyTypes true; do not assign undefined to non-optional schema fields; prefer bracket access on index signatures to avoid TS4111
What Was Implemented

Desktop MCP clients
apps/desktop/src/mcp-clients.ts
stdio filesystem client: supports filesystem.list using Node fs (demo-level)
sse client: connects in background; tool calls via POST &lt;base&gt;/call; returns JSON or `{ error }`; abortable via dispose()
Loader + hot-reload + IPC
apps/desktop/src/mcp-loader.ts, apps/desktop/src/ipc-mcp.ts, apps/desktop/src/preload.ts
Decrypt headers/env; watch config; preload exposes window.mcp.getConfig/watch/unwatch
Agent runtime + validation
packages/agent/src/index.ts: RuntimeData.callTool?: (name, params) => Promise&lt;unknown&gt;
packages/agent/src/tools/schemas.ts: zod schemas for filesystem.list and web.echo
packages/agent/src/workflows/plan-then-act.ts: plan → search (simulated) → tools (filesystem.list, web.echo) → synthesize; emits tool-event chunks with start/success/error
UI rendering
 Update 2025‑09‑15: ChatPanel removed. Assistant‑ui renders tool parts and progress.
apps/desktop/src/renderer/components/settings/mcp-config-status.tsx: status card shows path, loaded/missing badge, and servers
Desktop IPC chat transport
packages/app-shell/src/right-panel.tsx: desktop transport calls window.agent.chat; passes runtime: `{ mcpEnabled: true }`
Tests
Agent: tool schema tests, workflow tests
Desktop: mcp-clients stdio + sse tests; sse-call test with a tiny local HTTP server; preload + IPC unit tests
Desktop E2E: interactions tests passing; MCP E2E exists and is CI-skipped
Runtime/Build Notes

Add dependency in desktop to resolve dynamic @brainstrike/agent import:
apps/desktop/package.json: "@brainstrike/agent": "workspace:*"
Updated agent dev script:
packages/agent/package.json: dev: "tsup src/index.ts --watch --out-dir dist"
Type fixes:
Avoid undefined for optional fields with exactOptionalPropertyTypes
Use bracket property access for index-signatures to appease TS4111
Known benign Vite messages (externalized modules) during desktop renderer build
How To Run (Headless)

Build all: pnpm run build
Dev web: pnpm dev --filter @brainstrike/web
Dev desktop: pnpm --filter @brainstrike/agent dev in parallel with pnpm --filter @brainstrike/desktop dev
Tests:
Agent: pnpm --filter @brainstrike/agent test
Desktop unit: pnpm --filter @brainstrike/desktop test
Desktop E2E local/xvfb: cd apps/desktop && npx playwright test
Web E2E: pnpm --filter @brainstrike/web test:e2e
File Map (Key)

Desktop MCP
apps/desktop/src/mcp-clients.ts
apps/desktop/src/mcp-loader.ts
apps/desktop/src/ipc-mcp.ts
apps/desktop/src/ipc-agent.ts
apps/desktop/src/preload.ts
apps/desktop/src/renderer/components/settings/mcp-config-status.tsx
Agent
packages/agent/src/workflows/plan-then-act.ts
packages/agent/src/tools/schemas.ts
packages/agent/src/index.ts
UI
 packages/ui/src/assistant-ui-panel/**
App shell
packages/app-shell/src/right-panel.tsx
packages/app-shell/src/types/global.d.ts
Acceptance Criteria (Next Phase)

 SSE: Demonstrate a real MCP SSE server tool call path (non-POST shim) with validation, returning structured payloads that render in assistant‑ui
Agent: Map at least one additional tool via zod schemas; validate before dispatch; error surfaces via tool-event chunks
UI: Tool cards show additional details (progress, result summary, errors); right-panel banner indicating tool availability or config issues
Tests: Unit tests cover SSE call success/failure + schema validation; desktop E2E (local) exercises a working SSE-backed tool card; keep CI green (skip E2E if needed)
Pitfalls

Electron/Playwright CI: Electron 38 rejects --remote-debugging-port=0; desktop E2E remains CI-skipped unless versions are pinned or launch flags adjusted
exactOptionalPropertyTypes: never assign undefined when field is present; either supply string or omit
Dynamic import: keep eval-based import in main typed as any to avoid bundler/TS issues
Security: do not render untrusted HTML; keep code blocks plain; only decrypt in main via safeStorage
Suggested Next Tasks

SSE protocol: Replace POST &lt;base&gt;/call shim with actual MCP SSE request/reply (if spec/server available)
Schema mapping: add schemas for new tools and integrate into validateToolInput
UI polish:
Tool card improvements: progress/step details, expandable payload view, consistent error copy
Right panel banner/toast for MCP config loaded/missing/error (complements Settings status card)
Performance: virtualized message list; memoized selectors
Accessibility: roles, keyboard navigation, focus management
Targeted Commands

Type-check all: pnpm turbo run type-check --filter ./...
Build all: pnpm turbo run build --filter ./...
Desktop unit tests: pnpm --filter @brainstrike/desktop test
Desktop E2E (local): cd apps/desktop && npx playwright test
Web E2E: pnpm --filter @brainstrike/web test:e2e
Single Prompt (For An LLM Agent)
You are adding real MCP SSE tool execution and schema mapping to the Brainstrike monorepo and polishing the Chat Panel tool UX.

Constraints:

TypeScript strict; exactOptionalPropertyTypes — do not set fields to undefined
Desktop uses Electron (main+preload+renderer) with safeStorage; no plaintext secrets
Renderer only talks via preload APIs; do not expand IPC surface
Keep existing selectors: data-testid="tool-part", tool names like filesystem.list | web.echo
CI: desktop MCP E2E is skipped; keep unit tests and builds green
Steps:

Review current wiring:
apps/desktop/src/mcp-clients.ts (SSE + stdio)
apps/desktop/src/mcp-loader.ts, apps/desktop/src/ipc-mcp.ts, apps/desktop/src/preload.ts
packages/agent/src/tools/schemas.ts, packages/agent/src/workflows/plan-then-act.ts
 packages/ui/src/assistant-ui-panel/**
Implement SSE request/response following the actual MCP SSE server contract (replace POST &lt;base&gt;/call shim):
Add a request channel and parse SSE events for tool responses
Ensure header forwarding; support abort via controller
Map one additional MCP tool in the agent:
Add zod schema in packages/agent/src/tools/schemas.ts
Validate input, then call runtime.callTool(name, params); emit tool-events (start/success/error)
 Assistant‑ui tool card rendering:
Show progress/step details; add expandable payload (truncate long objects)
Retain current selectors; add data-testid if adding new sections
Tests:
Unit: SSE success/failure paths with mocked HTTP server; schema validation errors
Desktop E2E: local run to verify tool card appears for SSE tool
Keep CI green (skip desktop E2E if Electron/Playwright incompatibility persists)
Run:
pnpm turbo run type-check --filter ./...
pnpm turbo run build --filter ./...
pnpm --filter @brainstrike/desktop test
(optional local) cd apps/desktop && npx playwright test
Deliverables:

SSE client updates + schema mapping for a new tool
Agent workflow tool integration (validated) and tool-event streaming
 Assistant‑ui tool card UX improvements (progress/details/errors)
Updated unit tests; E2E validated locally
Brief docs note in ./09-13-2025-mastra-agent-implementation-plan.md under “MCP Wiring — Implementation Notes”
Do/Don’t:

Do keep dynamic import typed as any in main
Do not widen preload APIs
Do validate tool inputs with zod before dispatch
Do not include untrusted HTML in UI
Do preserve existing selectors and transport behavior
If blocked by SSE contract specifics, implement a thin adapter that can be swapped with a real MCP SSE client later, but keep schemas + UI ready for structured payloads.
