# `@brainstrike/app-shell` — AGENTS.md (scope: `packages/app-shell`)

> This file is **for the app-shell package only**. The monorepo root and other packages may have their own `AGENTS.md`. Treat this as living documentation—update it when commands, flags, or behaviors change.

## What this package is

A reusable **React 19** application shell and IDE chrome for Brainstrike apps. It provides the outer layout, navigation, the app-wide agent workspace, the routed application surface, the tabbed database surface, CSV export utilities, and light state slices (Zustand). It intentionally keeps business logic thin and delegates to sibling packages (`@brainstrike/ui`, `@brainstrike/db`, `@brainstrike/embeddings`, `@brainstrike/file-explorer-*`, etc.).

### Key exports (from `src/`)

* **Layout:** `AppLayout`, `AgentWorkspaceLayout`, `createAppConfig`, `RootLayoutContent`, `PageWrapper`, `navigationItems`
* **Agent workspace:** `AgentSidebarPanel`, `ThreadsPanel`, `AssistantChatPanel`, `DatabasePanel`
* **Database utilities:** `DatabaseDemoPanel`, `VectorStatusWithDb`, `QueueHud`
* **CSV:** `generateCSV`, `createCSVBlob`, `generateCSVFilename`, and richer exporters for files/chunks/embeddings
* **Stores (Zustand):** `panel-layout-store`, `context-explorer-layout-store`, `search-panel-store`, `db-panel-store`, `import-settings-store`, `vector-*` stores
* **Types:** `AppShellConfig`, `NavigationItem`, etc.

## Commands (run from repo root unless noted)

* **Build (this package only):**
  `pnpm turbo run build --filter @brainstrike/app-shell`
* **Watch (package dir):**
  `pnpm --filter @brainstrike/app-shell dev`
* **Type check:**
  `pnpm --filter @brainstrike/app-shell type-check`
* **Unit tests:**
  `pnpm --filter @brainstrike/app-shell test`
  (Watch: `pnpm --filter @brainstrike/app-shell test:watch`)
* **Coverage (repo split):**
  `pnpm test:coverage:split`
* **Lint:**
  `pnpm --filter @brainstrike/app-shell lint` (delegates to root lint)

> Turborepo guidance: compile libraries with **`tsc -b`** and keep dependencies where they’re used; don’t add bundlers to libraries unless required. This keeps cache hits predictable and avoids mangling for downstream app bundlers. ([Turborepo][1])

## Usage (host app)

Minimal pattern:

```tsx
import { AppLayout, createAppConfig, RootLayoutContent, navigationItems } from "@brainstrike/app-shell";

const config = createAppConfig({ navigationItems });
export function App() {
  return (
    <AppLayout config={config} currentPath="/">
      <RootLayoutContent
        navigationItems={navigationItems}
        contextExplorerPageContent={<YourHome />}
        settingsPageContent={<YourSettings />}
      />
    </AppLayout>
  );
}
```

### Heavy component lazy-loading

Heavy components (Database and Assistant) are lazy-loaded via `React.lazy()` for automatic code splitting and bundle optimization. This keeps the initial bundle lean while keeping the app-wide assistant workspace mounted across route switches.

**Assistant status resolution:** The Assistant panel calls `GET {base}/assistant/status`. In web builds it defaults to `/api/assistant/status`; in Electron you can provide `window.assistant.getUrl()` or `window.assistant.url` to override (see `resolveAssistantStatusUrl()`). An enabled Hosted Web response includes its registry-validated fixed server provider and model so the shell can seed an honest picker without renderer-side key discovery; Desktop may omit both and retain encrypted-key discovery.

**MCP tools:** MCP discovery remains part of the assistant runtime, but the shell intentionally has no standalone MCP status banner. Dedicated settings/diagnostics surfaces may show server names and the explicitly selected transport (`stdio`, `streamable-http`, or legacy `sse`), but must never expose URLs, headers, environment values, or credentials.

> MCP (Model Context Protocol) is the emerging standard for tool / data connectors—think "USB-C for AI apps." If you wire servers via MCP, tools will be discovered at runtime by the host assistant. Keep secrets out of client configs; prefer envs and isolated processes. ([Model Context Protocol][2])

## Architecture notes & opinions

### The “App Shell” concept

This package **renders the shell fast** and defers heavy features. It separates persistent UI (nav/sidebar/footer/panels) from feature content and uses lazy imports for DB-centric panes. This mirrors modern **PWA/App-Shell** guidance: cache the shell, hydrate quickly, stream content/work later. ([Medium][3])

### React 19 expectations

* Works cleanly with React 19—treat the shell as the boundary where you stage **transitions**, streaming states, and optimistic UI for in-panel interactions. Prefer idiomatic React 19 patterns (async transitions, actions, optimistic updates) instead of bespoke state machines unless needed. ([React][4])
* Keep state **close to use**; only put cross-cutting toggles in the provided stores. Don’t balloon global state. ([Incubyte Blog][5])

### State slices (Zustand) and persistence

All slices are compact, selector-first, and **SSR/test-safe** via `createJSONStorage` with a memory fallback. When adding a new slice:

* Persist only what must survive reloads (e.g., outer agent-shell layout, routed tab selection, context-explorer layout).
* Export tuple or primitive selectors for React Compiler friendliness and fewer re-renders.
* If you have to persist in SSR contexts, **wrap access** to `localStorage` and provide a memory fallback (this repo already does it).

> This matches Zustand’s recommended `persist` patterns and `createJSONStorage` usage; handle SSR by deferring direct `localStorage` access. ([Zustand Documentation][6])

### Vector, embeddings & queue integration

The shell surfaces vector status/queue controls in the database tab and a compact **Queue** summary in the status bar. The heavy lifting lives in sibling packages, but there are app-shell specific UX expectations:

* **Devices:** we heuristically detect the best device (WebGPU when available) and let users override to WASM/CPU. WebGPU drastically improves on-device inference latency; fall back to WASM where unsupported. ([ONNX Runtime][7])
* **Backfilling:** when an embedding set becomes active **and** coverage is partial, the shell attempts an auto-backfill (enqueue jobs) if the local worker is running.
* **Queue semantics:** The shell emits `brainstrike:queue-drained` when the embeddings queue becomes idle and `brainstrike:queue-progress` for live pending/processed/failed counts. Keep those contracts stable for dashboards listening in the renderer.
* **Throughput/latency:** we display jobs/min and P50/P95; avoid blocking the main thread—long operations must stream progress.

> If you move heavier models in-browser, keep an eye on ONNX Runtime Web’s WebGPU EP and its IO-binding/graph-capture options—they’re the current best path for fast, private, local inference. ([ONNX Runtime][7])

### PGlite + pgvector in the browser (DB tab)

The Database tab provides a **WASM Postgres** (`PGlite`) with **pgvector** inside the browser/Electron renderer. This is powerful but you must treat it as **local, user-scoped** storage:

* Works in modern browsers and Electron; persists to IndexedDB in the browser.
* Great for prototyping RAG and offline search; not a server replacement.
* pgvector supports exact search by default; approximate indexes (IVFFlat/HNSW) can speed lookups but increase complexity. **Use sparingly in browser contexts** and test before enabling. ([GitHub][8])

> Reference performance & index tuning resources (server-side focused but conceptually useful): comparisons of IVFFlat vs HNSW and tuning practices. If you try ANN in PGlite, gate it behind a flag and measure. ([Tembo][9])

### MCP awareness (Assistant runtime)

* The shell does **not** run agents; it hosts the Assistant panel while MCP tools are discovered by the runtime. Do not add a persistent MCP banner back to the chat surface. Keep transports isolated and pass secrets via env to providers—**never** embed actual credentials in client configs.
* As the MCP ecosystem grows (Windows + IDEs baking it in), expect more users to show up with preconfigured servers. Design descriptions/tooltips accordingly. ([The Verge][10])

> Security note: the **biggest risk** in MCP deployments today is **identity/secret sprawl**. Prefer ephemeral auth, least privilege, and central policy rather than static tokens sprinkled in config. ([TechRadar][11])

## Package policies for contributors & coding agents

1. **Stay within scope.** This package is UI chrome and panel plumbing—no domain logic. Don’t import React from agent/runtime packages or vice versa.
2. **Don’t start servers** or background daemons from here. The shell reflects state; it doesn’t own it.
3. **Streaming UX only.** Long-running actions must emit progress. Never block the main thread (no tight loops in render; push work to workers or async tasks).
4. **Keep stores tiny.** Export tuple selectors; persist only primitives necessary across reloads.
5. **Lazy loading** for heavyweight panels (primarily DB and Assistant surfaces) to optimize bundle size.
6. **No secrets in code.** If you need keys, they must be supplied by the host app through env/bridges, not hard-coded.
7. **Tests:** Use Vitest + RTL. Mock heavy modules (`@brainstrike/db`, `@brainstrike/embeddings`, Electron bridges) like existing tests do. Prefer role/text/`data-testid` queries. ([Next.js][12])
8. **Build discipline:** Keep `tsconfig` references accurate; use `tsc -b` for libraries. This allows Turborepo to cache and parallelize correctly. ([Turborepo][1])

## Shell contracts (for host apps & tools)

* **Assistant:** `AssistantChatPanel` calls `GET {assistantBase}/assistant/status -> {enabled:boolean,provider?:SupportedProvider,model?:string,reason?:string}`. Set `window.assistant.getUrl()` or `window.assistant.url` to override base. If disabled, the panel shows guidance instead of failing; provider and model are an atomic validated pair when present.
* **Threads:** `ThreadsPanel` is a placeholder-only shell surface for now. Keep it DB-free until thread persistence lands.
* **Vector status surfaces:** host `VectorStatusWithDialog` for embedding set management, worker controls, and queue health. The embedding queue adapter must flow through `DatabasePanel` into DB-facing views.
* **Search panel (optional):** state lives in `search-panel-store`; keep it persistent and small (query + a few flags). Don’t move search execution here—call into repositories/services instead.
* **Database tab:** lazy-loaded chunk that initializes PGlite when the database tab is opened or preloaded by the host app.

## CSV export expectations

Utilities in `csv-export-core.ts` and `csv-export-utils.ts` generate consistent CSV with BOM (Excel-safe), provide timestamped filenames, and include **chunk/embedding** projections when available.

## Performance tips (battle-tested)

* **Defer heavy components:** Keep `DatabaseTab` and `AssistantUiPanel` behind `lazy()` and flags. Don't "accidentally" import them in top-level modules.
* **WebGPU first, WASM second:** for local models, choose WebGPU when available; fall back gracefully. Avoid device thrashing—reinitialize models only every N chunks (user-tunable). ([ONNX Runtime][7])
* **App-Shell first paint:** Keep the shell static CSS and icons small; don’t let the database tab pull big deps until opened. (This echoes modern App-Shell guidance.) ([Medium][13])
* **Zustand selectors:** Always destructure selectors outside render loops; prefer tuple selectors to minimize render churn. (Matches official persistence guidance.) ([Zustand Documentation][6])

## Security & privacy checklist

### Core Security Requirements
* **No secrets in client bundles.** Period. Use environment variables, bridges, or secure injection patterns.
* **Input validation** for all user-provided data (file paths, search queries, panel inputs).
* **Proper error handling** without information leakage—don't expose internal paths or stack traces.
* **Dependencies scanned** for vulnerabilities using `pnpm audit` and automated scanning in CI.

### Assistant & MCP Security
* Assistant panel must **not** echo secrets from tools. Filter tool outputs and sanitize responses.
* If you surface MCP servers, show **counts and transports** only—never dump configs or credentials.
* **MCP server isolation** - keep transports isolated and pass secrets via environment variables.
* **Least privilege principle** - prefer ephemeral auth over static tokens in configurations.

### Data & Privacy Protection
* For on-device ML, default to **private** (no outbound calls) unless the user explicitly opts in.
* **File system permissions** - validate and sanitize all file paths before operations.
* **Memory pressure considerations** - dispose of sensitive data promptly, especially in embeddings.
* **Content Security Policy** - ensure CSP headers are properly configured for web builds.

### Development Security Practices
* **Secret management warnings** - prominently display warnings about hardcoded credentials.
* **Dependency security scanning** - run `pnpm audit` before commits and in CI.
* **Error boundary implementation** - prevent sensitive information from leaking through error messages.
* **Secure defaults** - all security-sensitive features should default to the most secure option.

## Browser/Electron behavior you should count on

* `window.assistant` and `window.mcp` bridges are **optional**. The UI must still render without them.
* We detect Electron loosely (`window.electronAPI`) only where needed.
* PGlite is initialized on-demand from the database tab; the UI presents "initializing" states during setup.

## Testing guidance (what “good” looks like)

* Use Vitest + RTL. Keep tests deterministic with **explicit mocks** for DB, embeddings, and bridges (see existing suites).
* Simulate route switching and persisting state across toggles (see `root-layout-content`, `agent-sidebar-panel`, and `database-panel` tests).
* Unit test helper functions (e.g., queue events, transactions) without the full DB by stubbing `query/transaction`.

> Community patterns: the 2025 default across React apps is Vitest + RTL + Playwright for E2E. Keep our unit tests fast and isolated; E2E runs live in app packages. ([Medium][14])

## When to touch this package vs. somewhere else

* **Here:** layout, panel chrome, HUDs, simple export utilities, tiny stores, runtime detection, progress/event wiring.
* **Not here:** agent runtime, tool execution, data pipelines, model orchestration, cross-app services.

## Appendix: background resources we align with

* **App Shell & PWA patterns** (fast shell, lazy content): ([Medium][3])
* **Turborepo best practices** (tsc, deps where used): ([Turborepo][1])
* **React 19 patterns** (async transitions, compiler-friendly code): ([React][4])
* **Zustand persistence & SSR-safe storage**: ([Zustand Documentation][6])
* **ONNX Runtime Web + WebGPU** (local inference): ([ONNX Runtime][7])
* **In-browser Postgres (PGlite) & pgvector**: ([GitHub][8])
* **pgvector indexing tradeoffs** (HNSW vs IVFFlat): ([GitHub][15])
* **MCP overview & security posture**: ([Model Context Protocol][2])

---

### Agent runbook (quick, safe defaults)

* Validate the package builds cleanly:
  `pnpm turbo run build --filter @brainstrike/app-shell`
* Run unit tests only for this package:
  `pnpm --filter @brainstrike/app-shell test`
* Don’t start dev servers. Don’t modify shared configs. Prefer `--filter` to keep scope tight.

---

**Notes for reviewers:**

* Peer deps: `react ^19`, `zustand ^5`.
* This package exports ESM in `dist/`. It must remain bundler-agnostic—do not introduce app-level bundling concerns here.

This should be everything you and coding agents need to operate inside `packages/app-shell` with confidence, while staying aligned with modern app-shell, React 19, MCP, and in-browser AI practices.

[1]: https://turborepo.com/docs/guides/tools/typescript "TypeScript"
[2]: https://modelcontextprotocol.io/ "What is the Model Context Protocol (MCP)? - Model Context ..."
[3]: https://medium.com/%40pvprasanth474/app-shell-architecture-service-workers-a-beginners-guide-6e444964c936 "App Shell Architecture & Service Workers: A Beginner's ..."
[4]: https://react.dev/blog/2024/12/05/react-19 "React v19"
[5]: https://blog.incubyte.co/blog/vitest-react-testing-library-guide/ "Vitest with React Testing Library: A Modern Approach to ..."
[6]: https://zustand.docs.pmnd.rs/integrations/persisting-store-data "Persisting store data - Zustand"
[7]: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html "Using WebGPU"
[8]: https://github.com/electric-sql/pglite "electric-sql/pglite: Embeddable Postgres with real-time, ..."
[9]: https://tembo.io/blog/vector-indexes-in-pgvector "Vector Indexes in Postgres using pgvector: IVFFlat vs HNSW"
[10]: https://www.theverge.com/news/669298/microsoft-windows-ai-foundry-mcp-support "Windows is getting support for the 'USB-C of AI apps'"
[11]: https://www.techradar.com/pro/mcps-biggest-security-loophole-is-identity-fragmentation "MCP's biggest security loophole is identity fragmentation"
[12]: https://nextjs.org/docs/app/guides/testing/vitest "Testing: Vitest"
[13]: https://medium.com/%40ancilartech/building-real-progressive-web-apps-in-2025-lessons-from-the-trenches-23422e1970d6 "Building Real Progressive Web Apps in 2025"
[14]: https://medium.com/%40theNewGenCoder/testing-react-apps-in-2025-how-to-actually-test-what-matters-ea15bffab03b "🧪 Testing React Apps in 2025 — How to Actually Test What ..."
[15]: https://github.com/pgvector/pgvector "pgvector/pgvector: Open-source vector similarity search for ..."
