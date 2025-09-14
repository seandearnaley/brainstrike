# Brainstrike Assistant UI — Desktop Runtime Handoff (2025‑09‑14)

Owner: Core Platform (Brainstrike)
Audience: Next developer/agent continuing Phase 4→5 work

---

## Copy‑Paste Agent Prompt (Start Here)

You are continuing the Brainstrike Assistant UI project in the Brainstrike monorepo. Your immediate goals are:

1) Finalize assistant‑ui tool UI polish (pretty JSON, progress lines, expand/collapse, copy).  
2) Add a desktop E2E smoke test covering send/stop/retry, code copy, and one MCP filesystem tool call.  
3) Add a long‑stream stability smoke (web) and ensure Stop works mid‑stream.  

Constraints and context:
- The web app uses `/api/assistant` (assistant‑stream Data Stream).  
- The desktop app uses a local HTTP assistant‑stream server bound to `127.0.0.1` and is auto‑discovered via `window.assistant.getUrl()`.  
- Keep secrets in Electron main (`safeStorage`); do not expose keys in renderer.  
- Maintain feature flag behavior. The assistant‑ui panel is on by default for web and desktop.  
- Do not reintroduce “plan text” into assistant output; plans are tool events only.  

Steps you should perform:
1. Run type, build, tests for confidence:
   - `pnpm -w turbo run type-check --filter ./...`
   - `pnpm -w turbo run build --filter ./...`
   - `pnpm -w turbo run test --filter ./...`
2. Tool UI polish (assistant‑ui):
   - Improve tool call visuals to pretty‑print JSON results, add expand/collapse for large payloads, and copy buttons.
   - Ensure progress events render as: `step (percent%) — note` when present.
3. E2E (desktop):
   - Add Playwright test to launch the Electron app, send a prompt, assert streamed text, run `filesystem.list`, verify tool card shows progress/result, and exercise Stop/Retry and code copy.
4. Long‑stream smoke (web):
   - Add a simple e2e that sends a long prompt, asserts stream remains stable, and that Stop cleanly aborts.
5. Keep docs updated (this handoff + plan doc) with any new flags, endpoints, or testing notes.

If anything fails to build, first check aliases resolve `@brainstrike/agent` to dist rather than src; avoid stale JS under `packages/agent/src`.

---

## System Overview (What exists now)

- Monorepo with web (Vite/React) and desktop (Electron) apps; shared packages under `packages/*`.
- Assistant core is in `@brainstrike/agent`, which emits a simple stream: `text-delta` and `tool-event` chunks.  
- Web uses an API route that adapts our agent stream to assistant‑stream’s Data Stream for assistant‑ui.  
- Desktop runs a local HTTP assistant‑stream server inside Electron main, discovered via preload and used by the same assistant‑ui panel.

---

## Key Decisions & Policies

- UI library: Use `assistant-ui` with the assistant‑stream Data Stream protocol (not AI SDK Elements) for both web and desktop.
- Desktop transport: Local HTTP server (127.0.0.1) in main; the panel resolves URL via `preload` IPC (`window.assistant.getUrl()`).
- Secrets: No `.env` in renderer; use Electron `safeStorage` with preload IPC only.
- Planning text: Do not stream “plan” text as assistant content. Plans are tool events only.
- Import discipline: Consumers must resolve `@brainstrike/agent` to built `dist` artifacts to avoid stale behavior.

---

## Code Map (Important files you will touch)

- Assistant runtime and mapping
  - Web route (assistant‑stream): `apps/web/src/app/api/assistant/route.ts`
  - Web dev/preview mapping: `apps/web/vite.config.mts` (devChatApiPlugin for `/api/assistant`)
  - Desktop server (assistant‑stream): `apps/desktop/src/assistant-server.ts`
  - Desktop main wire‑up: `apps/desktop/src/main.ts` (starts server, exposes URL, graceful shutdown)
  - Desktop preload bridge: `apps/desktop/src/preload.ts` (window.assistant.getUrl)
  - CSP for desktop: `apps/desktop/src/csp-utils.ts`

- Assistant‑ui panel (shared):  
  - Panel component: `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx`
  - Markdown renderer: `packages/ui/src/assistant-ui-panel/markdown-text.tsx`
  - Compact CSS overrides: `packages/ui/src/assistant-ui-panel/overrides.css`
  - App-shell integration (Right Panel): `packages/app-shell/src/right-panel.tsx` (lazy loads panel when flag enabled)
  - Feature flag helper: `packages/app-shell/src/env.ts` (`isAssistantUiEnabled()`)

- Agent workflow (for reference):  
  - Plan‑then‑act workflow: `packages/agent/src/workflows/plan-then-act.ts` (streams tool events and text deltas)

---

## What’s Already Shipped in This Phase

- Removed plan text from assistant stream; friendly default responses for greetings.
- Web assistant‑ui endpoint (`/api/assistant`) and dev/preview mapping using assistant‑stream.
- Desktop assistant‑ui runtime: local assistant‑stream server with tool bridging to MCP clients.
- Assistant‑ui panel wired for web and desktop (auto‑detects desktop URL; otherwise `/api/assistant`).
- Tool progress formatting in adapters: `step (percent%) — note`; pretty JSON for start payloads; setResponse for results.
- De‑dupe send guard in legacy `ChatPanel` to prevent accidental repeats.
- CSP updated to allow `http://127.0.0.1:*` for desktop.

Status: unit tests green across agent/ui/web; web route tests green; desktop type‑check green.

---

## Runbook (Commands)

- Install: `pnpm install`
- Type check all: `pnpm turbo run type-check --filter ./...`
- Build all: `pnpm turbo run build --filter ./...`
- Test all: `pnpm turbo run test --filter ./...`
- Web dev: `pnpm dev --filter @brainstrike/web` (assistant‑ui flag on by default)
- Desktop dev: see scripts in `apps/desktop/package.json` (vite dev on 8081; electron after wait-on)

---

## Flags & Configuration

- Assistant‑ui enablement:
  - Web: `apps/web/vite.config.mts` sets `globalThis.__VITE_ASSISTANT_UI__ = true`
  - Desktop renderer: `apps/desktop/vite.config.mts` sets `globalThis.__VITE_ASSISTANT_UI__ = true`
- DB UI toggle (desktop): `import.meta.env.VITE_ENABLE_DB_UI` (vite define) and fallback `globalThis.__VITE_ENABLE_DB_UI__` for TS builds.
- Desktop assistant server: binds 127.0.0.1 on an ephemeral port; exposed via `window.assistant.getUrl()`.

---

## Pitfalls & Gotchas

- Do not import `@brainstrike/agent` from `src`; always from `dist` in build/dev middleware. We deleted stray compiled JS under `packages/agent/src` to prevent drift.
- Progress events: some tool calls may emit periodic progress; ensure the UI updates without accumulating unbounded text.
- CSP: without 127.0.0.1 allowed, the renderer cannot reach the local assistant server.
- Hydration warnings seen in some layout tests are unrelated; avoid touching unrelated layout for this phase.

---

## Next Phase Objectives (You build these)

1) Assistant‑ui Tool UI polish
   - Pretty‑print JSON results; collapse large payloads with “Show more/less”.
   - Display progress as friendly lines and add copy buttons for payloads.
   - Show a status badge (start/progress/success/error) and tool name consistently.

2) Desktop E2E smoke (Playwright)
   - Launch, send prompt, assert streamed assistant text.
   - Run a filesystem tool (e.g., `list files in ~`), assert tool card with progress and final result.
   - Exercise Stop/Retry, code copy.

3) Long‑stream stability (web)
   - E2E to stream many tokens; assert Stop aborts cleanly and UI settles without leaks.

4) Observability (stretch)
   - Log tool timings and provider latency (dev only); keep logs behind a flag.

Definition of Done:
- All added e2e/unit tests green locally.
- No plan text leaks; progress lines render correctly; payloads readable.
- Desktop + web share the same assistant‑ui user experience for text and tools.

---

## Acceptance Checklist

- [ ] Tool UI shows pretty JSON and collapsible areas
- [ ] Progress lines render as `step (percent%) — note`
- [ ] Desktop e2e: send/stop/retry/copy and `filesystem.list` covered
- [ ] Web e2e: long‑stream + Stop smoke
- [ ] No hydration/CSP regression; no new console errors in production build

---

## Reference: Key Adapters

- Web assistant route: `apps/web/src/app/api/assistant/route.ts`
- Web dev assist mapping: `apps/web/vite.config.mts` (devChatApiPlugin → `/api/assistant`)
- Desktop assistant server: `apps/desktop/src/assistant-server.ts`
- Panel: `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx`

---

## Rollback Plan

- To disable assistant‑ui and fall back to legacy ChatPanel: set `globalThis.__VITE_ASSISTANT_UI__ = false` in the respective Vite configs, or gate in `packages/app-shell/src/env.ts`.
- Desktop server cleans up on app quit; no persistent state is written.

---

## Notes

- The desktop server integrates with MCP clients via `callTool`, so all progress/result mapping remains in one place.  
- If you change tool schemas, update both the agent zod validators and the assistant‑ui presentation to stay in sync.  
- Keep changes surgical; do not refactor unrelated UI/tests during this phase.

