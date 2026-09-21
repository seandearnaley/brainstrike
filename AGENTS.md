# AGENT GUIDELINES

Detailed subsystem contracts live in `docs/agents/`. **Before changing one of these areas, read its doc first** — they record hard-won invariants and settled rulings (many marked "do not relitigate"). They are living documents: update the doc and its paired tests in the same change, written per `docs/agents/README.md` — rules in the contract, their history in `docs/agents/<area>/` evidence files. Some local Claude Code setups may mirror these contracts through ignored `.claude/skills/`; that integration is optional and untracked, so the table below is the canonical agent-agnostic map.

Nearest `AGENTS.md` files add package-local rules; they supplement rather than
replace this root policy. Treat `docs/agents/*.md` as living contracts,
`docs/adr/` as settled decisions, and `docs/agents/<area>/` evidence files plus
dated plans/research under `docs/superpowers/`, `docs/archive/`, or other
date-stamped paths as historical evidence—not current behavior. Prefer code, tests, and live contracts when they
disagree with a historical document.

| Touching… | Read first |
| --- | --- |
| Assistant stream/tool chain: guards, watchdog, error processors, tool approval / permission engine, lifecycle hooks, plan mode & tool suspension, thread viewport scrolling | `docs/agents/assistant-runtime.md` |
| Persona subagents / delegation | `docs/agents/assistant-subagents.md` |
| Message persistence & reload hydration, run notifications, context usage meter | `docs/agents/assistant-persistence.md` |
| Providers/API keys, MCP transport selection, native tools + multi-registry, tool output budgets, MCP tool-preference persistence | `docs/agents/assistant-providers.md` |
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
| PR review/remediation, stacked delivery, CI reruns, GitHub workflows, React Doctor, knip | `docs/agents/ci-quality.md` |
| Logging, factory reset, adding any new persistence | `docs/agents/platform-contracts.md` |
| Creating, reading, updating, or triaging product/engineering tickets; linking PRs to tickets | `docs/agents/issue-tracker.md` |
| External triage-skill category/state roles and Brainstrike's Linear vocabulary | `docs/agents/triage-labels.md` |
| External domain-modeling or triage skills consuming project vocabulary and ADRs | `docs/agents/domain.md` |

Cross-cutting invariants (full detail + rationale in the docs):

- Local inference (embeddings + local LLM) runs ONLY in hidden renderer hosts — never in Electron main.
- Schema/catalog changes add to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. New `packages/db` tests need no lane registration: the recursive Vitest unit-project glob discovers them, and required Unit plus nightly coverage split that one project with the same native `--shard` set. `scripts/__tests__/db-test-discovery-contract.test.mjs` guards the recursive glob and a minimum file floor.
- Every PGlite construction site loads the full engine-extension set.
- Feature gating is capability-based (does the bridge exist?) — never `isElectron()` checks in shared code. Web omits desktop-only capabilities rather than stubbing them.
- Any new persistent store/state must be wired into factory reset.
- `@mastra/core` is Node-only (its shared chunk statically imports `fs`/`child_process`/`os`) — it MUST stay externalized in browser bundles, and Mastra stays an embedded library runtime with no HTTP surface of its own.
- Non-native typed libraries build JavaScript and declarations with `tsc -b`. Use tsup only when the package produces a real bundle boundary (workers/assets, required CJS interop, or a deliberately self-contained server bundle); never add tsup just to duplicate plain library emit. Native-addon packages remain `node-gyp` builds. Packages extending `packages/config/tsconfig/node-library.json` use TypeScript's `NodeNext` mode, emit Node-compatible ESM, and use `.js` in relative source specifiers.

## Stack & style

- TypeScript strict. Never `any` — prefer `unknown` + narrowing; discriminated unions over enums; annotate params and return types.
- React 19 + Vite, Tailwind CSS v4, pnpm workspaces (Turborepo), shared `@brainstrike/ui` components, PGlite-backed local-first persistence.
- Filenames kebab-case; components export PascalCase; hooks are `use-*.ts` exporting camelCase.

## Testing

- Vitest for unit/integration (`*.test.ts`, `*.integration.test.ts`); run a single test with `pnpm vitest run -t "test name"` from the package dir. The `*.integration.test.*` suffix marks env-sensitive tests (real PGlite/native binaries/wall-clock timing); a package's `test` script excludes them (stays turbo-cacheable) and its `test:integration` script runs only them via the root uncached `test:integration` task.
- Playwright for E2E: run non-interactively; prefer role/text/data-testid selectors over raw CSS.
- Desktop E2E can be flaky headless — diagnose, don't bypass.
- Agent-driven Electron renderer debugging (opt-in only, never in default E2E): `pnpm --filter @brainstrike/desktop dev:agent-debug`.

## CI

- Plain GitHub Actions. No CI *routing* labels, no generated proof artifacts, no custom planner/registry — do not reintroduce them. (Sole exception: the `coverage` label on-demand-triggers the advisory `coverage.yml`; see `docs/agents/ci-quality.md`.) Required PR checks come from `.github/workflows/test.yml`; web + desktop E2E smoke run on every PR; full E2E regression on schedule/dispatch.
- Claude review coverage requires an exact-head completed disposition and actual review content. Self-change skips and incomplete actions are not completed reviews. Use the trusted targeted invocation in `docs/agents/ci-quality.md`; never close/reopen a PR or restart Test merely to request review.
- React Doctor runs on every PR (`scope: changed` — only NEWLY introduced error-severity issues block). Local: `pnpm run react-doctor`. Its config invariants are pinned in `docs/agents/ci-quality.md`.

# Ultracite Code Standards

Zero-config Biome preset enforcing strict standards. Run `pnpm dlx ultracite fix` before committing; `pnpm dlx ultracite check` to check for issues.
