# AGENTS GUIDELINES

Be precise, tool-driven, and skeptical of your own assumptions: verify in code/tests before claiming anything is fixed; read the relevant files instead of assuming behavior; correctness > agreement. Start with the actual answer and match response length to the task.

> **Project Context:** Local-First (client-resident state; single-device today) • AI-Native (MCP/RAG-Optimized) • Web-Second.
> Latency-critical paths must not grow round-trip API dependencies; assume state resides on the client.
> Sync roadmap (settled 2026-07-28, BST-911): future sync covers the "mind" — threads/memory/prompts — never vectors/HNSW.
> No sync/CRDT machinery exists yet: do not design against a sync layer; only preserve cheap groundwork (uuidv7 PKs, tombstone/op-log seams) where the data layer is already being reworked.

## Working rules

- If requirements, intent, or target state are unclear, ask before writing code — don't fill gaps with plausible assumptions. Clear, low-impact changes: just proceed.
- Implement the simplest thing that satisfies the request. Touch only files related to the task; flag unrelated debt instead of fixing it in-band.
- **NO SILENT FALLBACKS.** Malformed config, unsupported routing, and broken capabilities throw or surface visibly — never coerce, never degrade quietly.
- Stop for explicit confirmation before: deleting files or overwriting large swathes of code; data migrations / dropping records / live-schema changes; irreversible terminal commands; deploying or pushing to remote environments; side-effectful external API calls.
- For non-trivial changes, know: where state lives (single source of truth), how you'd observe/debug it, what breaks if it's deleted, and whether async timing/ordering/cleanup is safe.
- The bar is a clean build, lint, type check, and unit tests all green **in the same run** after your change. CI double-checks; it is not your test runner.
- End coding tasks with a short summary: files changed (one line each), nearby files intentionally untouched, and follow-ups (or "None").

## Architecture docs — load on demand

Detailed subsystem contracts live in `docs/agents/`. **Before changing one of these areas, read its doc first** — they record hard-won invariants and settled rulings (many marked "do not relitigate"). They are living documents: update the doc and its paired tests in the same change. Some local Claude Code setups may mirror these contracts through ignored `.claude/skills/`; that integration is optional and untracked, so the table below is the canonical agent-agnostic map.

### Context-efficient lookup

Do not preload every contract. Start with this routing table, then search the
one relevant contract for the exact symbol, path, error text, or invariant you
are changing. Read the matching section and its named source/tests; verify the
claim there before widening context. A typical lookup is:

```bash
rg -n "<symbol|path|error text|invariant>" AGENTS.md docs/agents packages apps scripts
```

Nearest `AGENTS.md` files add package-local rules; they supplement rather than
replace this root policy. Treat `docs/agents/*.md` as living contracts,
`docs/adr/` as settled decisions, and dated plans/research under
`docs/superpowers/`, `docs/archive/`, or other date-stamped paths as historical
evidence—not current behavior. Prefer code, tests, and live contracts when they
disagree with a historical document.

| Touching… | Read first |
| --- | --- |
| Assistant stream/tool chain: guards, watchdog, error processors, tool approval / permission engine, lifecycle hooks, plan mode & tool suspension, thread viewport scrolling | `docs/agents/assistant-runtime.md` |
| Persona subagents / delegation | `docs/agents/assistant-subagents.md` |
| Message persistence & reload hydration, run notifications, context usage meter | `docs/agents/assistant-persistence.md` |
| Providers/API keys, MCP transport selection, native tools + multi-registry, tool output budgets | `docs/agents/assistant-providers.md` |
| MCP verification harness (`mcp-test-lab`), official conformance client/driver, conformance evidence schemas and links, MCP 2026 fleet working agreements | `docs/agents/mcp-conformance.md` (working agreements in `docs/agents/ci-quality.md`) |
| Adding any `@mastra/*` package; Mastra Server/Workspace/Browser/RequestContext; stream-mapper ownership; Mastra observability or evals | `docs/agents/mastra-boundary.md` |
| Embedding workers, local Gemma LLM, hidden hosts — **renderer-only inference is mandatory, never Electron main** | `docs/agents/local-inference.md` |
| DB migrations, model catalog changes, PGlite construction sites/extensions, browser first-run bootstrap, `DatabaseWorkScheduler` priorities / background-starvation bound | `docs/agents/database.md` |
| Agent self-query SQL sandbox, `brainstrike.querySelf`, the read-only role — **`statement_timeout` is inert in PGlite** | `docs/agents/agent-self-query.md` |
| Code execution (CodeExecutor seam, sandbox backends, run_python) — **no vm→fence downgrade, ever** | `docs/agents/code-execution.md` |
| Prompt workbench, AGENTS/CLAUDE workspace instructions, user-defined slash commands, Agent Skills / `SKILL.md`, edit-checkpoint undo, read-before-write staleness guards, workspace root identity | `docs/agents/workspace-context.md` |
| Explorer Search panel, markdown viewer, Tapestry per-file ranges | `docs/agents/explorer-search-tapestry.md` |
| Changeset/git diff engine, git inventory + worktree trust, the `changes` IPC domain, the Changes surface, or the git panel's Changes/History tabs | `docs/agents/changeset-diff.md` |
| Tree views (shared TreeTable), right-click / context action system, z-index of any dialog/popover/menu/tooltip | `docs/agents/ui-conventions.md` |
| GitHub workflows, React Doctor, knip | `docs/agents/ci-quality.md` |
| Logging, factory reset, adding any new persistence | `docs/agents/platform-contracts.md` |
| Creating, reading, updating, or triaging product/engineering tickets; linking PRs to tickets | `docs/agents/issue-tracker.md` |
| External triage-skill category/state roles and Brainstrike's Linear vocabulary | `docs/agents/triage-labels.md` |
| External domain-modeling or triage skills consuming project vocabulary and ADRs | `docs/agents/domain.md` |

Cross-cutting invariants (full detail + rationale in the docs):

- Local inference (embeddings + local LLM) runs ONLY in hidden renderer hosts — never in Electron main.
- Schema/catalog changes register in BOTH migration runners (numbered + drizzle `customMigrations`). New `packages/db` tests need no lane registration: the recursive Vitest unit-project glob discovers them, and required Unit plus nightly coverage split that one project with the same native `--shard` set. `scripts/__tests__/db-test-discovery-contract.test.mjs` guards the recursive glob and a minimum file floor.
- Every PGlite construction site loads the full engine-extension set.
- Feature gating is capability-based (does the bridge exist?) — never `isElectron()` checks in shared code. Web omits desktop-only capabilities rather than stubbing them.
- Any new persistent store/state must be wired into factory reset.
- `@mastra/core` is Node-only (its shared chunk statically imports `fs`/`child_process`/`os`) — it MUST stay externalized in browser bundles, and Mastra stays an embedded library runtime with no HTTP surface of its own.
- Non-native typed libraries build JavaScript and declarations with `tsc -b`. Use tsup only when the package produces a real bundle boundary (workers/assets, required CJS interop, or a deliberately self-contained server bundle); never add tsup just to duplicate plain library emit. Native-addon packages remain `node-gyp` builds. Packages extending `packages/config/tsconfig/node-library.json` use TypeScript's `NodeNext` mode, emit Node-compatible ESM, and use `.js` in relative source specifiers.

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
- React Doctor runs on every PR (`scope: changed` — only NEWLY introduced error-severity issues block). Local: `pnpm run react-doctor`. Its config invariants are pinned in `docs/agents/ci-quality.md`.

# Ultracite Code Standards

Zero-config Biome preset enforcing strict standards. Run `pnpm dlx ultracite fix` before committing; `pnpm dlx ultracite check` to check for issues.
