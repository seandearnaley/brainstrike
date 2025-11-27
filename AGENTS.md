# AGENTS GUIDELINES

You are expected to be precise, tool-driven, and skeptical of your own assumptions.

Key principles:
- Do not claim something is fixed/working without verifying in code/tests/logic.
- Do not assume behavior without reading the relevant files.
- The user and the agent can both be wrong; correctness > agreement.
- Prefer saying “I don’t know yet; let me check X” over guessing.

Always treat this file as authoritative and current.

---

## TICKET & CODE REVIEW WORKFLOW

Tickets tracked in Atlassian Jira with `BST-` prefix (e.g., BST-42, BST-123).

**Definition of Done (DoD):**

A ticket is DONE only when ALL conditions are met:
1. Code changes pushed to feature branch
2. CI pipeline passes (build, lint, type-check, tests)
3. PR opened and approved via code review
4. Branch merged to main
5. Ticket transitioned to Done in Jira

**Constraints:**
- Do NOT close/resolve tickets until PR is merged.
- Do NOT mark tickets Done if CI is failing.
- Do NOT skip code review—every change requires approval.
- Reference ticket ID in commits/PRs (e.g., "BST-42: Add feature X").

**Workflow:**
1. Pick ticket → move to In Progress
2. Create branch: `bst-42-f/short-description` (feature) or `bst-42-b/fix-description` (bugfix)
3. Implement → verify local CI parity (build, lint, type-check, test)
4. Push → open PR → request review
5. Address feedback → get approval → merge
6. Only then: close ticket

This prevents premature closure and ensures traceability from ticket → commit → PR → merge.

---

## TOOLING WORKFLOW (MCP / CODE NAVIGATION)

Use tools before speculating. Follow this order unless explicitly told otherwise.

Priority:
- Tier 1:
  - semantic_search_with_context
  - analyze_impact
- Tier 2:
  - find_symbol
  - get_calls
  - find_callers
- Tier 3:
  - search_symbols
  - semantic_search_docs
  - get_index_info

Default workflow:
1. Use semantic_search_with_context to locate relevant code + context.
2. Use analyze_impact to understand dependencies and change radius.
3. Use find_symbol / get_calls / find_callers for precise usage details.
4. Only then propose or apply changes.

Do not start dev servers or heavy processes unless explicitly requested.

---

## REPO OVERVIEW

- Monorepo with Turborepo + pnpm.
- Apps:
  - apps/web: React + Vite
  - apps/desktop: Electron
- Shared packages in packages/
  - queue: embedding queue (workerpool + p-queue fallback)
  - embedding-worker: Transformers.js worker; exposes resolveEmbeddingWorkerUrl()
  ...etc

Always confirm locations with semantic search before editing.

---

## BUILD, TEST, AND DEV COMMANDS

Use these unless instructions differ in the repo:

- Install:
  - pnpm install
- Dev (web):
  - pnpm dev --filter @brainstrike/web
- Build all:
  - pnpm build
- Lint/Format:
  - pnpm lint
  - pnpm format
- Type check:
  - pnpm type-check
- Unit/Integration:
  - pnpm test
  - pnpm test --filter <pkg>
- Web E2E:
  - pnpm test:e2e
  - pnpm test:e2e:ui
  - pnpm test:e2e:debug

Use:
- pnpm turbo run <task> --filter <pkg>
to leverage caching; avoid full-repo runs unless necessary.


@brainstrike/desktop:dev: ➜  Local:   http://localhost:8081/
@brainstrike/desktop:dev: ➜  Network: use --host to expose
@brainstrike/web:dev:   ➜  Local:   http://localhost:8080/

---

NOTE: On this team, the bar is that your final code has a clean build, lint, type check, and unit tests all passing together. That means after you make a change, you’re responsible for running the full suite again and iterating until **everything** is green in the same run. CI is there to double-check, not to tell you what you broke.

## ELECTRON E2E (PLAYWRIGHT) / HEADLESS LINUX

Electron needs a display; in CI/headless use Xvfb.

- Local (with DISPLAY):
  - pnpm -w build
  - pnpm --filter @brainstrike/desktop run test:e2e
- Headless Linux (CI/Docker/WSL/etc.):
  - Debian/Ubuntu:
    - apt-get update && apt-get install -y xvfb
  - Alpine:
    - apk add --no-cache xvfb xvfb-run xorg-server dbus
  - Then:
    - pnpm --filter @brainstrike/desktop run test:e2e:ci
      (wraps with scripts/run-with-xvfb.sh)

Playwright:
- Run headless.
- Do not modify playwright.config.*.
- Prefer role/text/data-testid selectors over raw CSS.

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
1. Renderer
   - File: apps/desktop/src/renderer/components/embedding-worker-provider.tsx
   - Uses startEmbeddingWorker() from @brainstrike/embeddings.
   - Starts when DB is ready.
   - Pulls jobs from PGlite-backed job_queue.
   - Uses workerpool + p-queue; supports local (WASM/WebGPU) and hosted (OpenAI, Google).
2. Main
   - File: apps/desktop/src/main.ts
   - Does NOT start the embedding worker.
   - Handles IPC, DB init, lifecycle.
   - Contains comments explaining renderer-only constraint.
3. Job Queue
   - File: packages/db/src/queue/job-queue.ts
   - Backed by job_queue table.
   - Lease-based locking, retries, dedupe, failure tracking.

Environment variables:
- VITE_EMBED_CONCURRENCY (default 1)
- VITE_EMBED_LEASE_MS (default 60000)
- VITE_EMBED_MODEL_KEY (e.g. local:Xenova/bge-m3, openai:text-embedding-3-small)

Do not move or reintroduce workers in main.

---

## AI ASSISTANT INTEGRATION

- Supports: OpenAI, Anthropic, Google, OpenRouter.
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

## CODING STYLE AND NAMING

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

## 10. EMBEDDING QUEUE TELEMETRY

Opt-in; disabled in NODE_ENV=test unless configured.

Enable via:
- VITE_QUEUE_TELEMETRY_ENDPOINT
- (optional) VITE_QUEUE_TELEMETRY_API_KEY

Collector:
- pnpm --filter @brainstrike/queue-telemetry-collector start
- Default: http://localhost:4130/queue-telemetry
- Config via:
  - QUEUE_TELEMETRY_HOST
  - QUEUE_TELEMETRY_PORT
  - QUEUE_TELEMETRY_PATH
  - QUEUE_TELEMETRY_API_KEY
  - QUEUE_TELEMETRY_MAX_BODY_BYTES

Behavior:
- Batches up to 20 events or 5s.
- Uses navigator.sendBeacon, falls back to fetch.
- For non-renderers, call initializeQueueTelemetrySink with runtime-derived endpoint.

UI integration:
- Renderer dispatches brainstrike:queue-progress events with pending/processed/failed.
- Subscribe via:
  - window.addEventListener('brainstrike:queue-progress', handler)

---

## 11. FACTORY RESET CONTRACT

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

## MERMAID DIAGRAMS

Edits are high-risk. Always validate.

After ANY Mermaid change:
- Run:
  - node .claude/skills/mermaid-diagrams/scripts/validate-mermaid.mjs

Common pitfalls:
- Parentheses in labels:
  - Use ["Label (with parens)"], not [Label (with parens)]
- ER diagrams:
  - No // comments in erDiagram blocks.
- Line breaks:
  - Use <br/>, not \n (unless in quoted strings).
- Special characters:
  - Quote labels with (), :, ,, /, etc.

Node shapes:
- [Label]          = rectangle
- (Label)          = rounded
- ([Label])        = stadium
- [(Label)]        = cylinder/database (valid parentheses)
- {Label}          = diamond

Always validate before commit.
See docs/mermaid-guide.md for details.

---

## 13. QUALITY BAR AND GLOBAL RESTRICTIONS

- Fix root causes; no “temporary” hacks or silent fallbacks.
- Do not downgrade dependencies just to pass builds.
- Do not modify:
  - shared config (tailwind.config.*, tsconfig.*, turbo.jsonc)
  - Playwright/Vitest/Vite configs
unless explicitly instructed.
- Tailwind v4:
  - Ensure apps/*/src and packages/*/src are scanned.
- TypeScript:
  - Keep compilerOptions.types explicit (e.g. ["node"]).
  - Don’t mix test-only types into build configs.
- React (compiler/HMR):
  - Follow repo’s react-compiler-and-hmr rules.
  - Do not change hook order/memo shapes arbitrarily.

No implicit fallbacks unless clearly required and documented.

---

## LIVING DOCUMENT

This file must be kept accurate:
- Update when commands, tools, architecture, or security constraints change.
- Treat AGENTS.md as the primary source-of-truth for both AI agents and humans.