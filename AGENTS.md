# AGENTS GUIDELINES

Be precise, tool-driven, and skeptical of your own assumptions: verify in code/tests before claiming anything is fixed; read the relevant files instead of assuming behavior; correctness > agreement. Start with the actual answer and match response length to the task.

> **Project Context:** Local-First (Edge-State/CRDT) • AI-Native (MCP/RAG-Optimized) • Web-Second.
> Latency-critical paths must not grow round-trip API dependencies; assume state resides on the client.

## Working rules

- If requirements, intent, or target state are unclear, ask before writing code — don't fill gaps with plausible assumptions. Clear, low-impact changes: just proceed.
- Implement the simplest thing that satisfies the request. Touch only files related to the task; flag unrelated debt instead of fixing it in-band.
- **NO SILENT FALLBACKS.** Malformed config, unsupported routing, and broken capabilities throw or surface visibly — never coerce, never degrade quietly.
- Stop for explicit confirmation before: deleting files or overwriting large swathes of code; data migrations / dropping records / live-schema changes; irreversible terminal commands; deploying or pushing to remote environments; side-effectful external API calls.
  - EXCEPTION — a scheduled Night Shift loop pushing to its OWN `night-shift/<name>/*` branch, for any push its charter authorizes: opening the PR, every later fix push while stewarding it, and Porter's revert PR under `charters/porter.md` Beat 3. The charter's `AUTONOMY` grant IS that confirmation, given in advance by a human-merged charter — a loop whose charter grants no PR-authoring authority is not covered here and should be holding no commit at all. Pushing a feature branch is not deploying: nothing reaches an environment, and the PR still lands in front of a human. Do not stall a validated commit waiting for an approval no one is awake to give — an unpushed local commit is discarded when the run ends, which loses the work AND hides that it happened. Still binding: never merge (except Porter within its committed `AUTHORITY_LEVEL`), never force-push, never push to `main` or a branch that is not yours, and never push a commit that would expose a live credential — `charters/sentinel.md`'s DISCLOSURE RULE governs that case and this exception does not override it.
- For non-trivial changes, know: where state lives (single source of truth), how you'd observe/debug it, what breaks if it's deleted, and whether async timing/ordering/cleanup is safe.
- The bar is a clean build, lint, type check, and unit tests all green **in the same run** after your change. CI double-checks; it is not your test runner.
- End coding tasks with a short summary: files changed (one line each), nearby files intentionally untouched, and follow-ups (or "None").

## Architecture docs — load on demand

Detailed subsystem contracts live in `docs/agents/`. **Before changing one of these areas, read its doc first** — they record hard-won invariants and settled rulings (many marked "do not relitigate"). They are living documents: update the doc and its paired tests in the same change. (Claude Code also auto-loads these via the `*-contract` skills in `.claude/skills/`; the table below is the agent-agnostic map.)

| Touching… | Read first |
| --- | --- |
| Assistant stream/tool chain: guards, watchdog, error processors, tool approval / permission engine, lifecycle hooks, plan mode & tool suspension, thread viewport scrolling | `docs/agents/assistant-runtime.md` |
| Persona subagents / delegation | `docs/agents/assistant-subagents.md` |
| Message persistence & reload hydration, run notifications, context usage meter | `docs/agents/assistant-persistence.md` |
| Providers/API keys, MCP transport selection, native tools + multi-registry, tool output budgets | `docs/agents/assistant-providers.md` |
| Adding any `@mastra/*` package; Mastra Server/Workspace/Browser/RequestContext; stream-mapper ownership; Mastra observability or evals | `docs/agents/mastra-boundary.md` |
| Embedding workers, local Gemma LLM, hidden hosts — **renderer-only inference is mandatory, never Electron main** | `docs/agents/local-inference.md` |
| DB migrations, model catalog changes, PGlite construction sites/extensions, browser first-run bootstrap | `docs/agents/database.md` |
| Agent self-query SQL sandbox, `brainstrike.querySelf`, the read-only role — **`statement_timeout` is inert in PGlite** | `docs/agents/agent-self-query.md` |
| Prompt workbench, workspace-instructions injection, user-defined /commands, edit-checkpoint undo | `docs/agents/workspace-context.md` |
| Explorer Search panel, markdown viewer, Tapestry per-file ranges | `docs/agents/explorer-search-tapestry.md` |
| Tree views (shared TreeTable), right-click / context action system, z-index of any dialog/popover/menu/tooltip | `docs/agents/ui-conventions.md` |
| GitHub workflows, React Doctor, knip | `docs/agents/ci-quality.md` |
| Logging, factory reset, adding any new persistence | `docs/agents/platform-contracts.md` |

Cross-cutting invariants (full detail + rationale in the docs):

- Local inference (embeddings + local LLM) runs ONLY in hidden renderer hosts — never in Electron main.
- Schema/catalog changes register in BOTH migration runners (numbered + drizzle `customMigrations`); new `packages/db` tests add a regex to `dbUnitLaneDefinitions` in `db-test-lane-manifest.mjs` — `test-lanes.mjs` and `coverage-lanes.mjs` both derive from that single manifest, so coverage lane assignment is automatic (only add a `coverageOverridesByLane` entry to override the default).
- Every PGlite construction site loads the full engine-extension set.
- Feature gating is capability-based (does the bridge exist?) — never `isElectron()` checks in shared code. Web omits desktop-only capabilities rather than stubbing them.
- Any new persistent store/state must be wired into factory reset.
- `@mastra/core` is Node-only (its shared chunk statically imports `fs`/`child_process`/`os`) — it MUST stay externalized in browser bundles, and Mastra stays an embedded library runtime with no HTTP surface of its own.

## Stack & style

- TypeScript strict. Never `any` — prefer `unknown` + narrowing; discriminated unions over enums; annotate params and return types.
- React 19 + Vite, Tailwind CSS v4, pnpm workspaces (Turborepo), shared `@brainstrike/ui` components, PGlite-backed local-first persistence.
- Filenames kebab-case; components export PascalCase; hooks are `use-*.ts` exporting camelCase.
- Reuse shared packages; avoid copy-paste divergence.

## Testing

- Vitest for unit/integration (`*.test.ts`, `*.integration.test.ts`); run a single test with `pnpm vitest run -t "test name"` from the package dir. The `*.integration.test.*` suffix marks env-sensitive tests (real PGlite/native binaries/wall-clock timing); a package's `test` script excludes them (stays turbo-cacheable) and its `test:integration` script runs only them via the root uncached `test:integration` task.
- Playwright for E2E: run non-interactively; prefer role/text/data-testid selectors over raw CSS.
- Desktop E2E can be flaky headless — diagnose, don't bypass.
- Agent-driven Electron renderer debugging (opt-in only, never in default E2E): `pnpm --filter @brainstrike/desktop dev:agent-debug`.

## CI

- Plain GitHub Actions. No CI *routing* labels, no generated proof artifacts, no custom planner/registry — do not reintroduce them. (Sole exception: the `coverage` label on-demand-triggers the advisory `coverage.yml`; see `docs/agents/ci-quality.md`.) Required PR checks come from `.github/workflows/test.yml`; web + desktop E2E smoke run on every PR; full E2E regression on schedule/dispatch.
- React Doctor runs on every PR (`scope: changed` — only NEWLY introduced error-severity issues block). Local: `pnpm doctor`. Its config invariants are pinned in `docs/agents/ci-quality.md`.

# Ultracite Code Standards

Zero-config Biome preset enforcing strict standards. Run `pnpm dlx ultracite fix` before committing; `pnpm dlx ultracite check` to check for issues.
