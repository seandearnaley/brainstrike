---
title: "20250913 120000 Mastra Agent Phase 2 3 Handoff"
status: "cold-archive"
date: "2025-09-13"
superseded_by: "none"
---

## PHASE 2–3 Handoff — Web Integration + Desktop Secrets & Local Agent

Date: 2025-09-13
Owner: Core Platform (Brainstrike)
Scope: Web chat UI wiring (Phase 2) + Desktop secrets and local agent IPC (Phase 3, partial)

### Summary
- Web side (historical): ChatPanel was originally wired into the Right Panel Props tab. Update 2025‑09‑15: Assistant‑ui replaced ChatPanel; routes remain (`/api/chat`, `/api/assistant`).
- Desktop side: Implemented secure secrets storage (safeStorage + electron-store) with IPC + preload; created Settings UI for provider keys; added local agent IPC (`agent:chat`). Update 2025‑09‑15: Right panel uses assistant‑ui; legacy ChatPanel transport removed.
- Unit tests are green across agent/ui/desktop; desktop E2E tests added for secrets and agent IPC (launch depends on environment/xvfb).

### Important Decisions
- Streaming contract: server routes (web) use newline-delimited JSON chunks compatible with AI SDK v5 consumption; desktop aggregates stream chunks via IPC and the renderer pseudo-streams them.
- Secrets: no `.env` in renderer; only encrypted blobs via `safeStorage` with `electron-store`; preload exposes a narrow API.
- Desktop Chat transport: prefer IPC (Option A) for local invocation to keep surface minimal and internal.
- UI location: ChatPanel lives in the Right Panel Props tab to preserve state and follow IDE layout patterns.

### Key Changes
- Web
  - `apps/web/src/app/api/chat/route.ts`: zod validation + newline-delimited JSON streaming.
  - `packages/app-shell/src/right-panel.tsx`: embeds AssistantUiPanel (ChatPanel removed).
  - `apps/web/e2e/assistant-panel.test.ts`: E2E ensuring right panel shim click then streaming.
- Desktop
  - `apps/desktop/src/secrets.ts`: secrets service with `safeStorage`/`electron-store`.
  - `apps/desktop/src/ipc-secrets.ts`: IPC `secrets:*` handlers (save/get/delete/list).
  - `apps/desktop/src/ipc-agent.ts`: IPC `agent:chat` aggregates chunks from `@brainstrike/agent`.
  - `apps/desktop/src/preload.ts`: exposes `window.secrets` and `window.agent`.
  - `apps/desktop/src/renderer/components/settings/page-content.tsx`: Includes model registry settings section and provider keys UI via `@brainstrike/preferences`.
  - `packages/app-shell/src/right-panel.tsx`: conditionally injects desktop transport when `window.agent.chat` exists.
  - Tests: `apps/desktop/src/__tests__/main/secrets.test.ts`, `apps/desktop/src/__tests__/renderer/preload-bridge.test.tsx`, `apps/desktop/e2e/secrets-settings.test.ts`, `apps/desktop/e2e/agent-ipc.test.ts`.

### Validation Status
- Web: unit/integration green; E2E `assistant-panel` green locally.
- Desktop: unit tests green; E2E added (secrets and agent IPC). Electron launch for Playwright depends on env/xvfb — run locally with your standard setup.

### Commands
- Type-check all: `pnpm turbo run type-check --filter ./...`
- Build all: `pnpm turbo run build --filter ./...`
- Web E2E: `cd apps/web && pnpm run test:e2e`
- Desktop unit: `pnpm --filter @brainstrike/desktop test`
- Desktop E2E (local): `cd apps/desktop && npx playwright test` (requires Electron/xvfb)

### Risks & Notes
- Desktop renderer build shows pre-existing Vite externalization warnings for Node modules; not altered here.
- Desktop E2E may fail to launch electron in some environments; use xvfb or headed mode.
- The desktop ChatPanel currently pseudo-streams chunks (array from IPC) to mimic streaming; can be upgraded to true incremental IPC later.

### Next Up (Proposed)
- Desktop: add a right-panel Chat E2E (UI flow) — created under `apps/desktop/e2e/assistant-panel.desktop.test.ts` (launch env required).
- Add stop/cancel and retry in ChatPanel; surface tool-events as cards; code block copy interaction tests.
- Optional: switch to AI SDK Elements/assistant-ui on the web client side for richer UI.
- Desktop Option B (local HTTP) if needed; otherwise continue with IPC-only to minimize surface.

### Appendix: API surfaces
- `POST /api/chat` (web): `\{ messages, data \}` → newline-delimited JSON `StreamChunk` lines
- `window.secrets`: `saveKey(provider, key)`, `getKey(provider)`, `deleteKey(provider)`, `list()`
- `window.agent.chat(messages, runtime?)` → `StreamChunk[]` (renderer pseudo-streams)
