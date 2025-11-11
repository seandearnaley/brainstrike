# Repository Guidelines

The user is extremely sceptical of the agent because AI agents like you have a terrible reputation for not telling the truth, that means, assuming things without having used the tool to read the things available to them, loudly proclaiming a bug is fixed despite them having only fixed a tiny part of a larger problem and telling the user they're right when they're actually wrong. Remember that you can be wrong and so can the user, but you both are striving for accuracy.

## Codanna MCP Tools

Tool priority:
- **Tier 1**: semantic_search_with_context, analyze_impact
- **Tier 2**: find_symbol, get_calls, find_callers
- **Tier 3**: search_symbols, semantic_search_docs, get_index_info

Workflow:
1. semantic_search_with_context - Find relevant code with context
2. analyze_impact - Map dependencies and change radius
3. find_symbol, get_calls, find_callers - Get specific details

Start with semantic search, then narrow with specific queries.


### Mermaid Diagrams
When creating or editing Mermaid diagrams in markdown files:

**CRITICAL**: Manual edits to Mermaid diagrams are highly error-prone. ALWAYS validate after making changes.

1. **After ANY edit to a Mermaid diagram, run the validation script**:
   ```bash
   node .claude/skills/mermaid-diagrams/scripts/validate-mermaid.mjs
   ```

2. **Common Mermaid syntax errors to avoid**:
   - **Parentheses in unquoted labels**: Use `["Label (with parens)"]` NOT `[Label (with parens)]`
   - **Comments in ER diagrams**: Do NOT use `//` comments in `erDiagram` blocks
   - **Line breaks**: Use `<br/>` for line breaks in labels, NOT `\\n` (unless quoted)
   - **Special characters**: Quote labels that contain: `()`, `:`, `,`, `/`, etc.

3. **Node shape syntax**:
   - Rectangle: `[Label]`
   - Rounded: `(Label)`
   - Stadium: `([Label])`
   - Cylinder/Database: `[(Label)]` - Note: this is valid use of parentheses
   - Diamond: `{Label}`

4. **Always test diagrams before committing**. The validation script catches syntax errors that may not be obvious.

See `docs/mermaid-guide.md` for comprehensive Mermaid documentation and best practices.

# desktop e2e

Note electron desktop e2e tests have trouble running in agent environments complaining of remote port issues, avoid running them in tests, instead ask the user to run them in their environment and report back.

## Project Structure & Modules
- Monorepo managed by Turborepo and pnpm.
- Apps in `apps/`: `web` (React/Vite) and `desktop` (Electron).
- Shared packages in `packages/`
  - `queue`: browser/Electron embedding queue (workerpool + p-queue fallback)
  - `embedding-worker`: Transformers.js module worker that exposes `resolveEmbeddingWorkerUrl()`

## Embedding Architecture (Updated January 2025)

### Critical: Renderer-Only Execution
**The embedding worker MUST run in the renderer process (browser context), NOT in Electron's main process.**

**Why:**
- Transformers.js requires Web Workers for async execution of WASM/WebGPU models
- Web Workers don't exist in Node.js/Electron main process
- If TransformersBackend runs in main process, it falls back to **synchronous WASM execution**
- Synchronous execution blocks the entire UI thread → app beachballs/freezes during embeddings

**Architecture Flow:**
1. **Renderer Process** (`apps/desktop/src/renderer/components/embedding-worker-provider.tsx`):
   - Auto-starts embedding worker when database is ready
   - Uses `startEmbeddingWorker()` from `@brainstrike/embeddings`
   - Worker polls job queue from PGlite database
   - Processes jobs using Web Workers (workerpool with p-queue fallback)
   - Supports local models (WASM/WebGPU) and hosted providers (OpenAI, Google)

2. **Main Process** (`apps/desktop/src/main.ts`):
   - Does NOT start embedding worker (removed as of brainstrike-47)
   - Only handles IPC, database initialization, and app lifecycle
   - Comments explain why worker must run in renderer

3. **Job Queue** (`packages/db/src/queue/job-queue.ts`):
   - Backed by PGlite database `job_queue` table
   - Jobs enqueued during file import/backfill
   - Worker claims jobs with lease-based locking
   - Supports retries, deduplication, and failure tracking

**Environment Variables:**
- `VITE_EMBED_CONCURRENCY`: Number of concurrent embedding jobs (default: 1)
- `VITE_EMBED_LEASE_MS`: Job lease timeout in milliseconds (default: 60000)
- `VITE_EMBED_MODEL_KEY`: Model to use (format: `provider:model-id`, e.g., `local:Xenova/bge-m3`, `openai:text-embedding-3-small`)

**Local vs Hosted Models:**
- **Local models** (e.g., `Xenova/bge-m3`, `jinaai/jina-embeddings-v2-small-en`):
  - Use transformers.js with WASM or WebGPU acceleration
  - Models download on first use (~100-500MB)
  - Work offline after initial download
  - Require Web Workers → renderer process only

- **Hosted providers** (e.g., `openai:text-embedding-3-small`, `google:text-embedding-004`):
  - Make API calls to remote services
  - Require API keys (stored in Settings → Embedding Providers)
  - Work in both main and renderer processes
  - Faster cold start (no model download)
  - Usage costs apply

**Worker Lifecycle:**
- Starts automatically when `EmbeddingWorkerProvider` mounts (after DB ready)
- Stops automatically on component unmount (app shutdown)
- Logs to structured logger: `createLogger('EmbeddingWorkerProvider')`
- Graceful shutdown: completes in-flight jobs before stopping

**Historical Context:**
- Pre-brainstrike-47: Worker ran in main process, causing beachball issue
- brainstrike-47: Moved worker to renderer, removed `EMBED_QUEUE_ENABLED` flag
- Worker is now always enabled (no confusing toggle)

**Future Work:**
- Hosted providers in main process for background processing (after fixing architecture)
- Renderer-to-main communication for job status updates
- Multi-model support with automatic provider selection

## AI Assistant Integration
- Multi-provider support: OpenAI, Anthropic, Google, OpenRouter
- Provider/model selection UI in Assistant Panel (right panel)
- API keys managed via Settings (desktop: encrypted keychain storage)
- Provider configuration in `packages/agent/src/providers/`
  - Model lists: `models.ts`
  - Key resolution: `key-resolver.ts`
  - Provider factory: `provider-factory.ts`
- State management: `packages/app-shell/src/stores/assistant-preferences-store.ts`
- Selection persists across sessions via localStorage
- **Assistant Status Endpoint Resolution**: The endpoint for checking assistant availability uses a three-tier fallback strategy:
  1. Attempts `window.assistant.getUrl()` (async function, allows dynamic configuration)
  2. Falls back to `window.assistant.url` (static string)
  3. Finally defaults to `/api/assistant/status`
  - This allows host applications to override the endpoint via Electron bridges or other runtime contexts
  - See `packages/app-shell/src/hooks/use-assistant-availability.ts` for implementation details

## Build, Test, Development
- Install deps: `pnpm install`
- Dev (web): `pnpm dev --filter @brainstrike/web`
- Build all: `pnpm build` (filters `./...`) — every workspace must succeed.
- Lint/Format: `pnpm lint` and `pnpm format`
- Type check: `pnpm type-check`
- Unit/Integration: `pnpm test` or `pnpm test --filter <pkg>`
- E2E (web): `pnpm test:e2e` | UI/debug: `pnpm test:e2e:ui`, `pnpm test:e2e:debug`

## Coding Style & Naming
- TypeScript strict; React 19+ with hooks; Tailwind v4.
- Filenames: kebab-case (`file-explorer.tsx`, `utility-functions.ts`).
- Components: PascalCase exports; file remains kebab-case.
- Hooks: file `use-kebab-case.ts`; export camelCase (`useDataFetcher`).
- Reuse shared packages.

## Testing Guidelines
- Frameworks: Vitest (unit/integration), Playwright (E2E in `apps/web`).
- Naming: `*.test.ts`, `*.integration.test.ts` with source.
- Focus a spec (from pkg dir): `pnpm vitest run -t "name"`.
- CI parity: builds, types, lint, unit/integration, and E2E must pass before PR.
- Note: desktop e2e tests sometimes have trouble running in headless environments

## Commit & PR Guidelines
- Conventional Commits: `<type>(<scope>): <subject>`
  - Types: feat, fix, docs, style, refactor, test, chore, ci, perf, build, revert, release
  - Scopes: auth, api, ui, config, deps, core, test, types, security, dx
- PRs: clear description, linked issues, steps to test, screenshots for UI, note migrations.

## Quality Bar
- Fail fast. No defensive fallbacks or “temporary” workarounds. No hidden indirection.
- Never downgrade to pass builds; fix root causes properly.
- Use `pnpm turbo run <script> --filter <pkg>` for targeted workflows.

- Do not start dev servers (`dev`, `start`, `serve`) unless explicitly asked. Assume the app/server is running.
- Playwright: run headless; do not modify `playwright.config.*`. Prefer role/text/`data-testid` selectors over CSS.
- Vitest: run per package via `pnpm turbo run test --filter <pkg>`; do not modify `vitest.config.*`.
- Turborepo: prefer `pnpm turbo run <task>` with `--filter` to leverage caching; avoid repo-wide runs unless requested.
- Vite: use per-package `cacheDir`; never share caches across apps/packages to avoid optimize-deps drift.
- Tailwind v4: ensure scanning of `apps/*/src` and `packages/*/src`; avoid excluding them in deploy ignores.
- TypeScript: keep build `compilerOptions.types` explicit (e.g., `["node"]`); do not include test-only types in build configs.
- React compiler/HMR: follow repo rule `react-compiler-and-hmr`; avoid changing hook order/memo shapes; reload on drift.
- Do not edit shared configs (`tailwind.config.*`, `tsconfig.*`, `turbo.jsonc`) without explicit instruction.
- No Implicit fallbacks unless explicitly requested/needed.
- Always timestamp documentation filenames with the date it was written.

# TypeScript Standards for Our Project

## Type safety
- strict mode and `noImplicitAny: true` in tsconfig.
- **Never use `any`.** It defeats type checking and hides errors. If a type cannot be inferred, use `unknown` and narrow it with type guards.
- Always annotate function parameters, return types and object literals.

## Utility types and patterns
- Prefer utility types (`Partial`, `Pick`, etc.) over handcrafted `any` patches.
- Use discriminated unions instead of enums for better exhaustiveness checking.
- Use generics with constraints for reusable functions.

Reasoning: Adhering to these guidelines produces code that is safer, easier to refactor and more compatible with our automated testing and linting pipelines.

## Logging
- Logging is centralized in `packages/utils/src/logger.ts` and uses Pino v10 for structured, performant logging across all runtimes.
- Prefer `initializeLogging` from `@brainstrike/utils` to register transports; pass `runtime` (`browser`, `electron-main`, `electron-renderer`) so shared defaults stay in sync.
- Desktop main configures logging during module evaluation and records both to the console and to `${app.getPath('logs')}/brainstrike.log` (debug level to file, info to console).
- Browser and renderer entry points call `initializeLogging` in their respective `main.tsx` files to share bindings (mode, app/version identifiers).
- Use `addLogListener` for tests or future remote sinks (e.g., Datadog) instead of mocking console APIs.

### Log Levels
Available levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`
- Set via code: `setLogLevel(LogLevel.DEBUG)`
- Set via environment: `LOG_LEVEL=debug` (case-insensitive)
- Priority: explicit code level > env var > dev/prod defaults

### Structured Logging
Prefer structured logging with data objects:
```typescript
// Good - structured
logger.info('User authenticated', { userId: '123', method: 'oauth' });

// Also works - backward compatible
logger.info('User authenticated', userId, method);
```

### Scoped Loggers
Create scoped loggers for components:
```typescript
const logger = createLogger('FileImporter');
logger.debug('Starting import', { fileCount: 10 });
// Output includes scope binding: { scope: 'FileImporter', fileCount: 10 }
```

### Sensitive Data
Default serializers automatically redact: `apiKey`, `password`, `token`, `secret`, `authorization`, `cookie`
Add custom redaction via `redactPaths` in `configureLogger`

### Testing
Use `addLogListener` to capture logs in tests:
```typescript
const logs: LogRecord[] = [];
const unsubscribe = addLogListener((record) => logs.push(record));
// run test code
unsubscribe();
expect(logs).toHaveLength(1);
```

## Embedding Queue Telemetry
- Remote queue telemetry is opt-in. Set `VITE_QUEUE_TELEMETRY_ENDPOINT` (and optional `VITE_QUEUE_TELEMETRY_API_KEY`) in web/desktop builds to enable `initializeQueueTelemetrySink` batching.
- Local collector: `pnpm --filter @brainstrike/queue-telemetry-collector start` builds & launches an HTTP listener (default `http://localhost:4130/queue-telemetry`). Configure the collector with env vars (`QUEUE_TELEMETRY_HOST`, `QUEUE_TELEMETRY_PORT`, `QUEUE_TELEMETRY_PATH`, `QUEUE_TELEMETRY_API_KEY`, `QUEUE_TELEMETRY_MAX_BODY_BYTES`).
- The sink batches up to 20 events or 5s, prefers `navigator.sendBeacon`, and falls back to `fetch`. It is disabled automatically when `NODE_ENV=test`.
- If you need telemetry outside the renderers, call `initializeQueueTelemetrySink` directly with an endpoint derived from your runtime config.
- Renderer layers dispatch `brainstrike:queue-progress` events containing `pending/processed/failed` counts so UI surfaces can react without polling. Subscribe via `window.addEventListener('brainstrike:queue-progress', handler)`.

## Factory Reset Contract
- Treat “Factory Reset Brainstrike” as a full device wipe. Wiping the SQLite/PGlite DB is not enough; the renderer must boot as if brand new.
- When adding a new persisted UI store, update `packages/db-explorer/src/utils/factory-reset-helpers.ts` with the storage key so `clearPersistentUiState()` nukes it. That helper also clears the Electron renderer storage bridge, IndexedDB databases (enumerated or from the fallback list), and CacheStorage bundles.
- If you introduce another persistence layer (Caches API, service worker store, filesystem handle, etc.), document it beside the helper and hook it into the reset pipeline or you’ll resurrect phantom embedding sets/providers after a wipe.
- Desktop reset order matters: dispose embeddings, clear UI state, purge DB tables (`job_queue`, `embedding_sets`), then reload. Don’t short-circuit the reload or the renderer may hydrate against stale cache entries.
- Add tests whenever you touch this flow (renderer unit tests can stub `window.electronAPI.storage.clear`, IndexedDB, and caches) so we know a regression won’t ship.


---------
This file should evolve alongside the repo. Treat it as **living  
documentation**: update it whenever build commands change, new tools are  
added or security considerations evolve. Keeping AGENTS.md accurate will  
ensure that coding agents and human contributors alike can work effectively  
with the Brainstrike monorepo.
