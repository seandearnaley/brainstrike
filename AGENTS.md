# Repository Guidelines

## Project Structure & Modules
- Monorepo managed by Turborepo and pnpm.
- Apps in `apps/`: `web` (React/Vite) and `desktop` (Electron).
- Shared packages in `packages/`

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


This file should evolve alongside the repo. Treat it as **living  
documentation**: update it whenever build commands change, new tools are  
added or security considerations evolve. Keeping AGENTS.md accurate will  
ensure that coding agents and human contributors alike can work effectively  
with the Brainstrike monorepo.
