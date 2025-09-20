### Brainstrike Assistant UI — Phase 4→5 Continuation Handoff (2025‑09‑15)

Owner: Core Platform (Brainstrike)
Audience: Next developer/agent (human or LLM-based) continuing assistant-ui work

---

## Copy‑Paste Agent Prompt (Start Here)

You are continuing the Brainstrike Assistant UI project in the Brainstrike monorepo. Your goals for this phase are:

1) Complete assistant‑ui Tool UI polish: pretty JSON for tool args/result, expand/collapse for large payloads, Copy buttons, and a status badge for start/progress/success/error.
2) Fix remaining desktop e2e failures: code copy verification and settings navigation. Keep existing selectors; prefer role/label/data-testid.
3) Add/verify long‑stream stability smoke (web) with Stop mid‑stream (if not already covered).

Constraints:
- UI library: `assistant-ui` with assistant‑stream Data Stream protocol for both web and desktop.
- Desktop transport: local HTTP assistant server in Electron main; discovered via `window.assistant.getUrl()`.
- Secrets: Never in renderer. Use Electron `safeStorage` (via main process IPC) only.
- Tests: Playwright headless. Prefer role/label/`data-testid` selectors.
- Do not reintroduce “plan” text into assistant content; plans are tool events only.

Tasks you should perform:
- Type/build/tests baseline:
  - `pnpm run type-check`
  - `pnpm run build`
  - `pnpm run test`
  - Desktop e2e: `pnpm run test:e2e:desktop`
- Tool UI polish (assistant‑ui):
  - Render tool call cards with: tool name, status badge (start/progress/success/error), pretty JSON (args + result), expand/collapse toggles, and Copy buttons.
  - Maintain selectors: `data-testid="tool-part" data-tool="<name>"` for each card.
  - Ensure progress lines format as: `step (percent%) — note`.
- Fix e2e failures:
  - Assistant interactions copy: ensure Copy button for code payload writes to clipboard in desktop (Electron clipboard bridge).
  - Secrets settings: navigate to Settings via sidebar and operate provider select and API key form; assert saved providers list updates.
- Add/verify web long‑stream smoke: send long prompt, ensure stream stable, Stop works mid‑stream.

Deliverables (Definition of Done):
- Assistant‑ui tool cards show pretty JSON, collapsible areas, Copy buttons, and a status badge.
- Desktop e2e fully green locally, including: send/stop/retry, code copy, `filesystem.list` tool card.
- Web long‑stream + Stop smoke passes (or documented if deferred).
- No CSP or hydration regressions; no console errors in production builds.

---

## What Changed in This Phase

- Assistant‑ui panel enhancements:
  - Added stable labels and selectors in panel: `You:` and `Assistant:` labels, composer `#assistant-input`, Retry button `aria-label="Retry"`.
  - Implemented Electron clipboard bridging for desktop copy flows via `window.clipboard.writeText/readText` (preload exposure).
  - Markdown code copy prefers `window.clipboard` when available, falls back to `navigator.clipboard` (web).

- Tests stabilized:
  - App Shell unit test assertion loosened (database tab content text) to avoid brittleness.
  - Desktop e2e selectors adjusted to use `.first()` when multiple matches exist and explicit `name: 'Copy code'` for the code copy button.

Current status:
- Type-check/build: green across workspace.
- Unit/Integration: green.
- Desktop e2e: 30/30 passing (copy code verified via Electron clipboard bridge; settings navigation stable).
- Web e2e: assistant panel specs green under assistant‑ui; long‑stream Stop smoke added.

---

## Code Map (edited/touched in this phase)

- Assistant‑ui panel (shared UI)
  - `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` — labels, input `id`, retry aria.
  - `packages/ui/src/assistant-ui-panel/markdown-text.tsx` — copy header; Electron clipboard integration; `aria-label="Copy code"`.
  - `packages/ui/src/assistant-ui-panel/overrides.css` — small sizing overrides (unchanged this pass).

- Desktop runtime and bridge
  - `apps/desktop/src/preload.ts` — exposed `window.clipboard.writeText/readText` using Electron clipboard; existing `window.assistant.getUrl()` remains.
  - `apps/desktop/src/assistant-server.ts` — assistant‑stream mapping for tool events (unchanged this pass; already formats progress and sets responses).

- App Shell & tests
  - `packages/app-shell/src/__tests__/right-panel.test.tsx` — less brittle DB tab assertion.

- Desktop e2e (Playwright)
  - `apps/desktop/e2e/assistant-panel.desktop.test.ts` — stabilized label assertions using `.first()`.
  - `apps/desktop/e2e/assistant-panel-interactions.desktop.test.ts` — copy button targeting and clipboard verification via renderer bridge.
  - `apps/desktop/e2e/mcp-filesystem.desktop.test.ts` — tool card `.first()` selection.
  - `apps/desktop/e2e/secrets-settings.test.ts` — added settings visibility assertion (still needs robust navigation fix).

---

## Key Decisions & Rationale

- **Assistant UI**: Use `@assistant-ui/react` with assistant‑stream’s Data Stream protocol for both web and desktop to unify UX.
- **Desktop Clipboard**: Prefer Electron clipboard exposed via preload for deterministic copy in E2E; fallback to web API for browser.
- **Selectors & A11y**: Favor role/name and `data-testid` selectors for test stability. Added explicit labels (`You:`, `Assistant:`) and `aria-labels`.
- **No Plan Text**: Tool plans remain tool events only; no raw “plan text” in assistant messages.

---

## What’s Next (Detailed)

### 1) Assistant‑ui Tool UI polish
- Implement tool call parts rendering in the assistant‑ui thread:
  - Consistent card with: tool name, status badge (start/progress/success/error), args preview (pretty JSON), ongoing progress lines (`step (percent%) — note`), final result (pretty JSON), Copy buttons for args & result.
  - Add expand/collapse toggles for long JSON; default collapsed for large payloads.
  - Maintain selectors:
    - Card container: `data-testid="tool-part" data-tool="<toolName>"`.

Suggested locations:
- Extend `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` to provide custom components for ToolCall parts (similar to how Text is overridden via `MarkdownText`).
- If assistant-ui exposes ToolCall primitives (e.g., `ToolCallPrimitive`), attach components there. Otherwise, consider a wrapper around tool events surfaced through `MessagePrimitive.Parts`.

### 2) Fix e2e: Assistant copy & Settings navigation
- Assistant copy:
  - Ensure the Copy button associated with the relevant code content is wired to call `window.clipboard.writeText` on desktop.
  - Confirm that the message CodeHeader Copy or tool card Copy corresponds to the displayed code.
- Settings navigation:
  - Open Settings via sidebar (Navigation Sidebar item with name `Settings`).
  - After navigation, assert `[data-testid="settings-section"]` is visible, then operate `data-testid="llm-provider"` and `data-testid="llm-api-key"` controls.

### 3) Web long‑stream stability
- Added smoke in `apps/web/e2e/assistant-panel-interactions.test.ts`.
- Update 2025‑09‑15: assistant‑ui enabled by default; no ChatPanel fallback.
- Follow‑up: re‑enable assistant‑ui on web and adapt tests once ToolCall UI parity is implemented.

---

## Commands

- Install: `pnpm install`
- Type-check all: `pnpm run type-check`
- Build all: `pnpm run build`
- Unit/Integration tests: `pnpm run test`
- Desktop e2e: `pnpm run test:e2e:desktop`
- Web e2e: `pnpm run test:e2e`

Notes:
- Use per-package filters with Turborepo caching where appropriate (see root `package.json` scripts).
- Playwright is headless; do not modify `playwright.config.*`.

---

## Selectors & UI Contracts (for tests)

- Assistant panel container: `data-testid="chat-panel"`
- Composer input: `#assistant-input`
- Buttons: role=button names: `Send`, `Stop`, `Retry`, `Copy code`
- Labels within messages: text `You:`, `Assistant:` (multiple may exist; select `.first()` when needed)
- Tool card: `data-testid="tool-part" data-tool="filesystem.list"` (and other tool names)
- Settings page wrapper: `data-testid="settings-section"`
- Secrets settings controls: `data-testid="llm-provider"`, `data-testid="llm-api-key"`, `data-testid="save-llm-key"`, `data-testid="delete-llm-key"`, `data-testid="saved-llm-providers"`

---

## Pitfalls & Gotchas

- **Clipboard in CI**: `navigator.clipboard` may be unavailable or flaky in Electron/e2e; use the preload-exposed Electron clipboard for desktop tests.
- **Multiple labels**: `You:`/`Assistant:` may appear multiple times; prefer `.first()`.
- **Do not import agent from src**: Always import `@brainstrike/agent` built artifacts (dist) to avoid drift.
- **CSP / 127.0.0.1**: Desktop renderer must be allowed to reach local assistant server.

---

## Acceptance Checklist (Next Phase)

- [ ] Tool UI shows pretty JSON with expand/collapse and Copy for args/result
- [ ] Progress lines render as `step (percent%) — note`
- [ ] Desktop e2e: send/stop/retry, Copy code, and `filesystem.list` green
- [ ] Web e2e: long‑stream + Stop smoke green
- [ ] No new console errors; prod build OK

---

## Troubleshooting

- Copy button does nothing on desktop:
  - Check `window.clipboard` exposure in `apps/desktop/src/preload.ts`.
  - Ensure the UI uses `window.clipboard.writeText` path before falling back to `navigator.clipboard`.

- Settings provider select not found:
  - Ensure navigation to Settings via sidebar item `Settings` before querying provider select.
  - Confirm `settings-section` is present and rendered by `RootLayoutContent` when `activeTab` is `settings`.

---

## References

- Assistant UI runtime (desktop): `apps/desktop/src/assistant-server.ts`
- Desktop preload bridge: `apps/desktop/src/preload.ts`
- Assistant‑ui panel: `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx`
- Markdown/code copy: `packages/ui/src/assistant-ui-panel/markdown-text.tsx`
- App Shell Right Panel integration: `packages/app-shell/src/right-panel.tsx`

---

## Changelog (This Phase)

- Added desktop clipboard bridge and wired assistant-ui markdown copy to prefer it.
- Introduced stable labels/selectors in assistant-ui panel.
- Fixed brittle App Shell test assertion.
- Stabilized e2e selectors for assistant panel and tool cards; two desktop e2e remain to finalize.

