### Brainstrike Assistant UI — Phase 5.1 Provider Wiring + Stability Handoff (2025‑09‑15)

Owner: Core Platform (Brainstrike)
Audience: Next developer/agent (human or LLM-based) continuing assistant-ui work

---

## Copy‑Paste Agent Prompt (Start Here)

You are continuing the Brainstrike Assistant UI project in a Turborepo monorepo. Your goals for this pass:

1) Ensure desktop assistant-ui streams real OpenAI completions using the saved key; no greeting fallbacks.
2) Finish assistant-ui ToolCall card parity (pretty JSON for args/result, collapsible, Copy buttons, status badges).
3) Re-enable assistant-ui on web and adapt E2E to assistant-stream; keep tests fast and stable.

Critical constraints:
- Desktop must use assistant-ui always (not the legacy ChatPanel).
- Web can temporarily use ChatPanel only if assistant-ui parity is incomplete; otherwise use assistant-ui with assistant-stream.
- Secrets never in renderer; read OpenAI key from Electron `safeStorage` via preload IPC and pass to agent server.
- Tests: Playwright headless; prefer role/name/`data-testid` selectors; adjust timeouts rather than brittle selectors.

Do the following in order:
1. Verify `openai` provider streaming via SSE in desktop. Prompt: "Summarize this repo in two sentences." Confirm the reply streams fully and ends cleanly (no hanging dot).
2. Implement assistant-ui ToolCall parts in `AssistantUiPanel`: pretty JSON for args + result, collapsible sections, header Copy buttons, and status badge for `start|progress|success|error`. Keep `data-testid="tool-part" data-tool="<name>"`.
3. Re-enable assistant-ui on web (set `globalThis.__VITE_ASSISTANT_UI__ = true` in `apps/web/vite.config.mts`), then adapt the two assistant-panel E2E specs to assistant-stream semantics.
4. Run only targeted tests first (desktop assistant panel, web assistant panel), then full E2E if time allows.

Deliverables:
- Desktop assistant-ui streams real model output; Stop and completion end cleanly.
- ToolCall cards rendered with pretty JSON, collapsible, Copy buttons, and status badge.
- Web assistant-panel specs green under assistant-ui.
- Handoff notes updated here if you change anything material.

---

## What Changed in This Phase

Provider wiring and stability:
- Removed greeting fallback in `@brainstrike/agent` so assistant no longer loops with “Hello! How can I help?”.
- Implemented OpenAI provider wiring with SSE streaming:
  - `packages/agent/src/providers/openai.ts`: uses Chat Completions streaming (SSE) with fetch; parses `data:` lines; stops on `[DONE]`; flushes trailing buffer to avoid UI hanging on last char.
  - `packages/agent/src/index.ts`: `toAiSdkStyleStream` prefers OpenAI when `apiKey` is present on runtime; else falls back to `plan-then-act`.
  - `apps/desktop/src/assistant-server.ts`: injects `apiKey` from `safeStorage` (provider `openai`) into runtime. Types normalized (`string | undefined`).
  - `apps/desktop/src/secrets.ts`: added singleton accessor `getSecretsService()` for runtime consumers.

Assistant UI routing:
- Desktop: forced assistant-ui in right panel when desktop runtime is present; the legacy ChatPanel is no longer used on desktop.
- Web: temporarily set `globalThis.__VITE_ASSISTANT_UI__ = false` during earlier stabilization; E2E updated. You will re-enable after ToolCall parity.

E2E and typing:
- Desktop E2E is fully green (30/30). Web E2E green with ChatPanel (assistant-ui re-enable pending ToolCall parity).
- TS diagnostics fixed for window bridges in E2E by using explicit casts where needed and updating types.
- Vite config typing warnings suppressed using `@ts-expect-error` for plugins and awaiting async preview middleware.

---

## Key Decisions & Rationale

- **Assistant UI always on desktop**: Right panel now renders `AssistantUiPanel` if `window.assistant` exists; ensures parity with assistant-stream.
- **OpenAI via SSE**: Implemented generic, dependency-light streaming over SSE to avoid SDK type/version drift and ensure deterministic termination on `[DONE]`.
- **No greeting fallback**: Greeting fallback caused user-visible confusion and repeated generic replies; removed in favor of either tool events or real provider output.
- **Web parity gated by ToolCall cards**: Web assistant-ui is disabled only until ToolCall parity is implemented to avoid flakiness; tests already adjusted and should be reverted once parity lands.

---

## File Map (Touchpoints)

- Agent provider & routing
  - `packages/agent/src/providers/openai.ts` — SSE streaming implementation.
  - `packages/agent/src/index.ts` — select OpenAI vs. fallback workflow.
  - `packages/agent/src/workflows/plan-then-act.ts` — no greeting fallback; emits tool events.

- Desktop server & secrets
  - `apps/desktop/src/assistant-server.ts` — passes `apiKey` into runtime from secrets; streams assistant-stream to renderer.
  - `apps/desktop/src/secrets.ts` — `createSecretsService`, `getSecretsService` singleton.
  - `apps/desktop/src/preload.ts` — exposes `window.secrets`, `window.assistant`, `window.clipboard`.

- Assistant UI
  - `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` — assistant-ui wiring (desktop/web), message labels, composer, Retry/Stop.
  - TODO (next you): add ToolCall part components with pretty JSON, collapse, Copy, badge.

- App-shell routing
  - `packages/app-shell/src/right-panel.tsx` — desktop: assistant-ui forced; web flag-controlled.

- Web config & E2E
  - `apps/web/vite.config.mts` — assistant-ui flag, dev chat API middleware; TS expectations on plugin types.
  - `apps/web/e2e/assistant-panel*.test.ts` — adjusted assertions; re-enable assistant-ui once parity is done.

---

## Selectors & UI Contracts

- Assistant panel container: `data-testid="chat-panel"`
- Composer input: `#assistant-input`
- Buttons (role=button): `Send`, `Stop`, `Retry`, `Copy code`
- Labels within messages: `You:`, `Assistant:` (may appear multiple times; use `.first()`)
- Tool cards (required): `data-testid="tool-part" data-tool="<toolName>"`

---

## Known Issues / Pitfalls

- If streaming appears to "hang" on last character:
  - Ensure SSE parsing stops on `[DONE]` and the TextDecoder flush happens after the stream ends.
  - UI should not rely solely on tool events for completion; ensure a final close is observed in the provider iterator.
- Desktop clipboard: `navigator.clipboard` can be flaky in headless; use `window.clipboard` from preload.
- Avoid importing agent from `src`; use built `@brainstrike/agent` artifacts in runtime to prevent drift.

---

## Commands (Targeted)

- Build agent only:
  - `pnpm --filter @brainstrike/agent build`
- Run desktop E2E (headless):
  - `pnpm -w run test:e2e:desktop`
- Run only two web assistant-panel specs (fast):
  - `cd apps/web && pnpm run test:e2e -- --reporter=line e2e/assistant-panel.test.ts e2e/assistant-panel-interactions.test.ts`

---

## What To Do Next (Checklist)

1) ToolCall UI parity in assistant-ui
- Implement ToolCall parts in `AssistantUiPanel`:
  - Pretty JSON for tool args/result; large payloads collapsed by default.
  - Copy buttons for args and result.
  - Status badge: `start|progress|success|error`.
  - Keep selectors: `data-testid="tool-part" data-tool="<name>"`.

2) Re-enable assistant-ui on web
- In `apps/web/vite.config.mts`, set `globalThis.__VITE_ASSISTANT_UI__ = true`.
- Update the two assistant-panel web specs to assert assistant-stream semantics (visible tool-part where applicable, or stable streamed text with Stop/Retry).

3) Validation
- Desktop: send prompt, Stop mid-stream, Retry, copy code block; confirm local tool card (e.g., `filesystem.list`) renders and shows progress/result JSON.
- Web: long prompt streaming + Stop; assistant-ui enabled; specs green.

4) Documentation
- If you change the provider surface (model mapping, error behavior), update this doc and `09-15-2025-assistant-ui-phase-5-handoff.md` acceptances.

---

## Troubleshooting

- Provider returns 401/403 or empty: verify `openai` key saved via Settings; check it’s injected from secrets in the desktop server.
- TypeScript failures in E2E for window bridges: cast `(window as unknown as { mcp?: {...}; secrets?: {...} })` within `evaluate()`; bridges are exposed by preload.
- Vite plugin types: `@ts-expect-error` acceptable in config; do not ship broken types into app code.

---

## Reference Snippet: Robust SSE Parsing (Chat Completions)

Use this pattern (already implemented) to parse `data:` lines, ignore keep‑alives, and stop on `[DONE]`. Ensure you flush the TextDecoder once the stream closes.

```ts
// see packages/agent/src/providers/openai.ts for working version
```

---

## Acceptance Criteria (This Handoff)

- Desktop assistant-ui streams real OpenAI completions; Stop/Retry work; no greeting fallback.
- SSE parsing terminates correctly; no hung dot or stuck cursor.
- Clear checklist and next actions documented; another agent/dev can continue without missing context.


