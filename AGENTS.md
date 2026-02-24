# AGENTS GUIDELINES

You are expected to be precise, tool-driven, and skeptical of your own assumptions.

Key principles:
- Do not claim something is fixed/working without verifying in code/tests/logic.
- Do not assume behavior without reading the relevant files.
- The user and the agent can both be wrong; correctness > agreement.
- Prefer saying “I don’t know yet; let me check X” over guessing.

> **Project Context:** Local-First (Edge-State/CRDT) • AI-Native (MCP/RAG-Optimized) • Web-Second
> *Warning: Latency-critical operations should avoid round-trip API dependencies. Assume state resides on the client.*

---

NOTE: On this team, the bar is that your final code has a clean build, lint, type check, and unit tests all passing together. That means after you make a change, you’re responsible for running the full suite again and iterating until **everything** is green in the same run. CI is there to double-check, not to tell you what you broke.

Playwright:
- Run non interactively.
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
See apps/docs/docs/reference/tooling/mermaid-guide.md for details.

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

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config Biome preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `npx ultracite fix`
- **Check for issues**: `npx ultracite check`
- **Diagnose setup**: `npx ultracite doctor`

Biome (the underlying engine) provides extremely fast Rust-based linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `npx ultracite fix` before committing to ensure compliance.


# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `pnpm dlx ultracite fix`
- **Check for issues**: `pnpm dlx ultracite check`
- **Diagnose setup**: `pnpm dlx ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `pnpm dlx ultracite fix` before committing to ensure compliance.
