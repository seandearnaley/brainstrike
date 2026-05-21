# AGENTS GUIDELINES

You are expected to be precise, tool-driven, and skeptical of your own assumptions.

Key principles:
- Do not claim something is fixed/working without verifying it in code, tests, or logic.
- Do not assume behavior without reading the relevant files.
- The user and the agent can both be wrong; correctness > agreement.
- Prefer saying "I don't know yet; let me check X" over guessing.
- Start with the actual answer, analysis, or current position. Avoid filler openings.
- Match response length to task complexity. Simple answers should stay short.

> **Project Context:** Local-First (Edge-State/CRDT) • AI-Native (MCP/RAG-Optimized) • Web-Second
> *Warning: Latency-critical operations should avoid round-trip API dependencies. Assume state resides on the client.*

---

## ENTRY PROTOCOL

Before starting any task, classify ambiguity and choose the thinnest safe response loop:

- **High ambiguity:** Stop and ask clarifying questions before planning or editing.
- **Medium ambiguity:** State the most likely interpretation, identify the gaps, and wait for confirmation before committing to an approach.
- **Low ambiguity:** Verify mentally, trust the user's intent, and proceed when the change is clear, specific, and low impact.

If requirements, intent, architectural fit, or target state are unclear, ask before writing code. Do not fill gaps with plausible assumptions.

For complex architectural, data, or database tradeoffs, slow down and reason through ownership, scale, failure modes, and alternatives before recommending a direction.

---

## SYSTEMIC CHECKLIST

Trace these dimensions before writing or shipping non-trivial code:

1. **State Ownership:** Where does state live? Preserve a single source of truth, keep the blast radius low, and maintain consistency.
2. **Feedback & Observability:** Where does feedback live? Add or preserve logging, metrics, UI visibility, or test hooks needed for debugging.
3. **Fragility & Coupling:** What breaks if this is deleted? Map dependencies before refactoring or removing code.
4. **Timing & Ordering:** When does timing matter? Account for async work, races, retries, leases, initialization order, and cleanup order.

Verification gate for non-trivial changes:
- State ownership and consistency are clear.
- Feedback and observability paths are adequate for safe debugging.
- Blast radius is mapped and the change is isolated.
- Timing, async patterns, and execution order are safe.
- The solution fits existing codebase patterns.

---

## EXECUTION DISCIPLINE

- Implement the simplest thing that satisfies the request. Avoid premature abstractions, speculative flexibility, and unrequested features.
- Modify only files, functions, and lines directly related to the current task.
- Do not refactor, optimize, or tidy unrelated code during execution. Flag unrelated structural debt after the task instead.
- If uncertain about a fact, convention, statistic, or behavior, say so and verify before relying on it.
- Prefer invariants and existing patterns over defensive layers that hide unclear ownership.

Stop and wait for explicit confirmation before:
- Deleting files or overwriting large swathes of existing code.
- Dropping records, running data migrations, or modifying active schemas.
- Running terminal commands with systemic or irreversible side effects.
- Deploying, pushing, or modifying remote environments.
- Sending external API calls that create, mutate, publish, notify, bill, or otherwise have side effects.

Post-task coding summaries must include:
- **Files Changed:** every touched file.
- **What Was Modified:** one-line description per file.
- **Files Intentionally Not Touched:** boundary validation for nearby code or tempting follow-ups.
- **Follow-Up Needed:** next actions, deferred debt, or "None."

---

NOTE: On this team, the bar is that your final code has a clean build, lint, type check, and unit tests all passing together. That means after you make a change, you’re responsible for running the full suite again and iterating until **everything** is green in the same run. CI is there to double-check, not to tell you what you broke.

Playwright:
- Run non interactively.
- Prefer role/text/data-testid selectors over raw CSS.

Agent DevTools Debugging:
- For local, agent-driven Electron renderer debugging, use:
  `pnpm --filter @brainstrike/desktop dev:agent-debug`
- This is opt-in only. Do not add `--remote-debugging-port` to default desktop E2E.
- Main process debugging remains separate via Electron `--inspect`.

---

## PR CI PROOF FLOW

Pull requests are gated by a local proof manifest plus label-routed cloud lanes.

Before opening or updating a PR:
1. Commit all source, config, workflow, test, and doc changes except the proof manifest.
2. Run `pnpm ci:select --base origin/main --head HEAD`.
3. Add every listed `ci:*` label to the PR.
4. Run `pnpm ci:prove --base origin/main --head HEAD`.
5. Commit `.ci/proof/latest.json` by itself as the final proof-only commit.
6. Run `pnpm ci:verify-proof --base origin/main --head HEAD --labels '<ci:labels>'`.

Use `origin/main` for PRs targeting `main`. If the PR targets another branch,
replace `origin/main` with that target branch ref in all proof commands.

Label meanings:
- `ci:browser` runs browser Vitest lanes.
- `ci:web-e2e` runs web functional, stateful, and destructive E2E lanes.
- `ci:desktop` runs desktop regression E2E.
- `ci:embedding` runs desktop embedding E2E groups.
- `ci:coverage` runs cloud unit coverage.
- `ci:full` expands to all cloud risk lanes.

The PR Sentinel recomputes the selected lanes and fails when the proof is
missing, stale, or missing required labels. Any commit after the proof commit
invalidates the proof unless the only changed file is `.ci/proof/latest.json`.

---

## 5. EMBEDDING ARCHITECTURE (CRITICAL)

Renderer-only execution is mandatory.

Rules:
- Embedding worker MUST run in renderer (browser context).
- MUST NOT run in Electron main process.

Reasons:
- Transformers.js requires Web Workers (renderer only).
- In main/Node, it degrades to synchronous WASM → freezes UI.

Flow:
1. Hidden host renderer
   - Files:
     - apps/desktop/src/embedding-host-manager.ts
     - apps/desktop/src/renderer/components/embedding-host-app.tsx
     - apps/desktop/src/renderer/components/embedding-host-runtime.tsx
   - Main creates a hidden BrowserWindow with `?mode=embedding-host`.
   - The host renderer mounts `DbProvider` with `useElectronIPC=true`.
   - The host renderer uses `startEmbeddingWorker()` from `@brainstrike/embeddings`.
   - It pulls jobs from the PGlite-backed `job_queue`.
   - Local models still execute in browser/Web Worker context only.
2. Visible renderer
   - File: packages/vector-management/src/vector-status/use-embedding-worker-controls.ts
   - Does NOT start the embedding worker directly in desktop mode.
   - Talks to the hidden host over the preload bridge (`window.embeddingHost`).
   - Keeps UI controls/status in sync with host lifecycle.
3. Main
   - File: apps/desktop/src/main.ts
   - Does NOT run embeddings in-process.
   - Owns host-window lifecycle, IPC, DB init, and power lifecycle.
   - Visible window uses default background throttling; only the hidden host disables throttling.
   - `powerSaveBlocker` is allowed only while the hidden host reports active embedding work.
4. Job Queue
   - File: packages/db/src/queue/job-queue.ts
   - Backed by job_queue table.
   - Lease-based locking, retries, dedupe, failure tracking.

Environment variables:
- VITE_EMBED_CONCURRENCY (default 1)
- VITE_EMBED_LEASE_MS (default 60000)
- VITE_EMBED_MODEL_KEY (e.g. local:Xenova/bge-m3, openai:text-embedding-3-small)

Do not move or reintroduce workers in Electron main. Desktop local embeddings must stay in the hidden renderer host.

---

## AI ASSISTANT INTEGRATION

- Supports: OpenAI, Anthropic, Google, OpenRouter.
- Built-in local provider:
  - Desktop/web local inference targets `onnx-community/gemma-4-E2B-it-ONNX` only.
  - No silent fallback to WASM. If WebGPU is unavailable, the built-in local provider is unavailable.
- API keys:
  - Managed via Settings.
  - Desktop: encrypted keychain.
- Config:
  - packages/agent/src/providers/models.ts
  - packages/agent/src/providers/key-resolver.ts
  - packages/agent/src/providers/provider-factory.ts
- State:
  - packages/app-shell/src/stores/assistant-preferences-store.ts
  - Persists via localStorage.

Assistant status endpoint resolution (in order):
1. window.assistant.getUrl()  (async)
2. window.assistant.url       (static)
3. /api/assistant/status      (fallback)

Implementation:
- packages/app-shell/src/hooks/use-assistant-availability.ts

When changing this flow, update this doc.

---

## LOCAL LLM ARCHITECTURE (CRITICAL)

Renderer-only execution is mandatory for the built-in local LLM path.

Rules:
- Local Gemma inference MUST run in renderer (browser context).
- MUST NOT run in Electron main process.
- Desktop MUST use the hidden `llm-host` renderer for built-in local LLM work.
- Web MUST use the browser-safe `@brainstrike/agent/local-llm` entrypoint.

Reasons:
- Transformers.js Gemma runtime depends on browser/WebGPU surfaces that are renderer-only.
- Running model load/generation in Electron main would degrade to the wrong runtime surface and risks UI/process instability.
- Hidden-host execution avoids visible-renderer throttling and keeps the UI responsive during model warmup/generation.

Flow:
1. Hidden host renderer (desktop)
   - Files:
     - apps/desktop/src/llm-host-manager.ts
     - apps/desktop/src/ipc-llm-host.ts
     - apps/desktop/src/llm-host-shared.ts
     - apps/desktop/src/renderer/components/llm-host-app.tsx
     - apps/desktop/src/renderer/components/llm-host-runtime.tsx
   - Main creates a hidden BrowserWindow with `?mode=llm-host`.
   - The host renderer owns `LocalLlmBackend` initialization, warmup, generation, and progress events.
   - The host renderer reports status/progress/response back to main over dedicated IPC channels.
2. Visible renderer
   - Files:
     - packages/ui/src/assistant-ui-panel/local-runtime-adapter.ts
     - packages/app-shell/src/assistant-ui-panel-wrapper.tsx
   - Does NOT run the built-in local LLM directly in desktop mode.
   - Talks to the hidden host over the preload bridge (`window.llmHost`).
   - Owns UI state only: reasoning/tool panels, streaming snapshots, and status affordances.
3. Main
   - Files:
     - apps/desktop/src/main.ts
     - apps/desktop/src/preload.ts
   - Does NOT execute Gemma inference in-process.
   - Owns hidden-host lifecycle, IPC registration, and shutdown/reset coordination.
4. Shared local runtime
   - Files:
     - packages/agent/src/local-llm.ts
     - packages/agent/src/providers/local/local-llm-backend.ts
     - packages/agent/src/providers/local/gemma4-engine.ts
     - packages/agent/src/providers/local/local-model-specs.ts
     - packages/agent/src/providers/local/local-artifact-store.ts
   - `local-llm.ts` is the browser-safe entrypoint for renderer usage.
   - `LocalLlmBackend` is a thin orchestrator over the Gemma engine/spec/artifact layers.
   - Tool calls are executed through the existing UI/runtime tool bridge; reasoning/tool details are hidden by default in the UI and expandable on demand.

Constraints:
- Built-in local model downloads are manifest-based, not single-file heuristics.
- Thinking/reasoning output must be kept separate from the final visible answer.
- Control tokens (`<turn|>`, EOS markers, tool-call wrappers, etc.) must be stripped from visible output.
- If you change the local host lifecycle, preload bridge, or availability gating, update this section and the relevant tests.

---

## 6. TREEGRID CONVERGENCE CONTRACT

File-tree and context preview tree behavior is converging on shared TreeTable primitives.

Rules:
- Use `packages/ui/src/tree-table/*` as the canonical treegrid implementation.
- Prefer adapting feature surfaces to TreeTable API over duplicating tree render logic in app/package code.
- Keep UX parity between:
  - File explorer tree (left nav).
  - Context explorer grouped preview tree (main panel).
- Preserve WAI-ARIA treegrid semantics (`role="treegrid"`, row/level metadata, keyboard traversal).

Windowing and performance:
- Default strategy should remain `auto` unless a product requirement explicitly pins behavior.
- For search-heavy and large result flows, paged windowing is acceptable when it produces more stable UX than virtual scrolling.
- Avoid full-tree rematerialization during render paths; keep derived rows memoized and keyed by stable node ids.
- Any new tree interaction (selection, sort, collapse, keyboard behavior) must include tests in both shared UI package and consuming feature package when behavior diverges.

When modifying TreeTable strategy or pagination behavior:
- Update the related collection browser/file explorer/context preview adapters.
- Add or update tests validating grouped slicing semantics and selection correctness.
- Document intentional tradeoffs (e.g., paged vs virtual) in code comments or PR notes.

---

## CODING STYLE AND NAMING

Stack lock:
- Language: TypeScript.
- Apps: React 19+ with Vite for `apps/web`; Electron renderers use React.
- Package manager: pnpm workspaces.
- Styling: Tailwind CSS v4 and shared `@brainstrike/ui` components.
- Testing: Vitest for unit/integration and Playwright for E2E.
- Persistence: local-first state and PGlite-backed storage where applicable. Do not introduce round-trip API dependencies into latency-critical paths without an explicit requirement.

- TypeScript strict; noImplicitAny: true.
- Never use any. Prefer unknown + narrowing.
- Annotate function parameters, return types, and object literals.
- Prefer:
  - Utility types (Partial, Pick, etc.).
  - Discriminated unions over enums (for exhaustiveness).
  - Generics with constraints when useful.

Naming:
- Filenames: kebab-case.
  - file-explorer.tsx, utility-functions.ts
- Components:
  - File: kebab-case
  - Export: PascalCase
- Hooks:
  - File: use-kebab-case.ts
  - Export: camelCase (e.g. useDataFetcher)

Reuse shared packages; avoid copy-paste divergence.

---

## TESTING EXPECTATIONS

- Frameworks:
  - Vitest for unit/integration.
  - Playwright for E2E.
- Naming:
  - *.test.ts
  - *.integration.test.ts
- Example:
  - pnpm vitest run -t "test name" (from package dir)

CI parity:
- Builds, types, lint, unit/integration, and E2E must pass before merge.
- Desktop E2E can be flaky in headless; diagnose, don’t bypass.

---

## LOGGING (PINO V10)

Centralized logging: packages/utils/src/logger.ts

Usage:
- Use initializeLogging from @brainstrike/utils.
- Set runtime: browser | electron-main | electron-renderer.
- Desktop main:
  - Logs to console + ${app.getPath('logs')}/brainstrike.log
- Web/renderer:
  - Call initializeLogging in main.tsx.

Log levels:
- trace, debug, info, warn, error, fatal, silent
- Configure via:
  - setLogLevel(LogLevel.DEBUG)
  - LOG_LEVEL=debug (env)
- Priority: code > env > defaults.

Structured logs:
- Prefer objects:

  logger.info('User authenticated', { userId: '123', method: 'oauth' });

Scoped loggers:
- createLogger('FileImporter')

Sensitive data:
- Auto-redacts: apiKey, password, token, secret, authorization, cookie
- Add more via redactPaths.

Testing:
- Use addLogListener instead of mocking console.

---

## 10. FACTORY RESET CONTRACT

“Factory Reset Brainstrike” = true fresh start.

Rules:
- Wiping DB alone is NOT enough.
- Renderer must boot as if never used.

Implementation:
- Update:
  - packages/preferences/src/factory-reset/factory-reset-helpers.ts
  - Ensure clearPersistentUiState() includes:
    - All new persistent UI store keys.
    - Electron renderer storage bridge.
    - IndexedDB (enumerated + fallback list).
    - CacheStorage.

If you add new persistence (Caches API, service worker, filesystem handles, etc.):
- Document it next to the helper.
- Integrate into reset pipeline.
- Otherwise stale embeddings/providers may reappear.

Desktop reset order:
1. Dispose embeddings.
2. Clear UI state.
3. Purge DB tables (job_queue, embedding_sets, etc.).
4. Reload renderer.
Do not skip reload.

Add tests when changing reset behavior.

---

## LIVING DOCUMENT

This file must be kept accurate:
- Update when commands, tools, architecture, or security constraints change.
- Treat AGENTS.md as the primary source-of-truth for both AI agents and humans.

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config Biome preset that enforces strict code quality standards through automated formatting and linting. Most formatting and common issues are automatically fixable.

## Quick Reference

- **Format code**: `pnpm dlx ultracite fix`
- **Check for issues**: `pnpm dlx ultracite check`
- **Diagnose setup**: `pnpm dlx ultracite doctor`

Run `pnpm dlx ultracite fix` before committing to ensure compliance.
