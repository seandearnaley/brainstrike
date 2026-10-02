# AGENT GUIDELINES

Detailed subsystem contracts live in `docs/agents/`. **Before changing one of these areas, read its doc first** — they record hard-won invariants and settled rulings (many marked "do not relitigate"). Update a contract only when the behaviour it describes changes (working rule 11). Some local Claude Code setups may mirror these contracts through ignored `.claude/skills/`; that integration is optional and untracked, so the table below is the canonical agent-agnostic map.

Nearest `AGENTS.md` files add package-local rules; they supplement rather than
replace this root policy. Treat `docs/agents/*.md` as living contracts,
`docs/adr/` as settled decisions, and `docs/agents/<area>/` evidence files plus
dated plans/research under `docs/superpowers/`, `docs/archive/`, or other
date-stamped paths as historical evidence—not current behavior. Prefer code,
tests, and live contracts when they disagree with a historical document.

| Touching… | Read first |
| --- | --- |
| Assistant stream/tool chain: guards, watchdog, error processors, tool approval / permission engine, lifecycle hooks, plan mode & tool suspension, thread viewport scrolling | `docs/agents/assistant-runtime.md` |
| Persona subagents / delegation | `docs/agents/assistant-subagents.md` |
| Message persistence & reload hydration, run notifications, context usage meter | `docs/agents/assistant-persistence.md` |
| Providers/API keys, MCP transport selection, native tools + multi-registry, tool output budgets, MCP tool-preference persistence | `docs/agents/assistant-providers.md` |
| MCP verification harness (`mcp-test-lab`), official conformance client/driver, conformance evidence schemas and links, MCP 2026 fleet working agreements | `docs/agents/mcp-conformance.md` (working agreements in `docs/agents/ci-quality.md`) |
| Adding `effect` or any `@effect/*` package, writing Effect code, `@brainstrike/effect-kit`, Effect Schema at a runtime boundary | `docs/agents/effect-boundary.md` |
| Adding any `@mastra/*` package; Mastra Server/Workspace/Browser/RequestContext; stream-mapper ownership; Mastra observability or evals | `docs/agents/mastra-boundary.md` |
| Embedding workers, local Gemma LLM, hidden hosts — **renderer-only inference is mandatory, never Electron main** | `docs/agents/local-inference.md` |
| DB migrations, model catalog changes, PGlite construction sites/extensions, desktop database root/profile (packaged vs dev, DB host env), browser first-run bootstrap, `DatabaseWorkScheduler` priorities / background-starvation bound | `docs/agents/database.md` |
| Agent self-query SQL sandbox, `brainstrike.querySelf`, the read-only role — **`statement_timeout` is inert in PGlite** | `docs/agents/agent-self-query.md` |
| Code execution (CodeExecutor seam, sandbox backends, run_python) — **no vm→fence downgrade, ever** | `docs/agents/code-execution.md` |
| Prompt workbench, AGENTS/CLAUDE workspace instructions, user-defined slash commands, Agent Skills / `SKILL.md`, edit-checkpoint undo, read-before-write staleness guards, workspace root identity | `docs/agents/workspace-context.md` |
| Explorer Search panel, markdown viewer, Tapestry per-file ranges | `docs/agents/explorer-search-tapestry.md` |
| Changeset/git diff engine, git inventory + worktree trust, the `changes` IPC domain, the Changes surface, or the git panel's Changes/History tabs | `docs/agents/changeset-diff.md` |
| Tree views (shared TreeTable), tab strips (shared TabStrip) and view switchers (Tabs), right-click / context action system, the app reload gate and failed lazy chunks, z-index of any dialog/popover/menu/tooltip | `docs/agents/ui-conventions.md` |
| PR review/remediation, stacked delivery, CI reruns, GitHub workflows, React Doctor, knip | `docs/agents/ci-quality.md` |
| Logging, factory reset, adding any new persistence | `docs/agents/platform-contracts.md` |
| Creating, reading, updating, or triaging product/engineering tickets; linking PRs to tickets | `docs/agents/issue-tracker.md` |
| External triage-skill category/state roles and Brainstrike's Linear vocabulary | `docs/agents/triage-labels.md` |
| External domain-modeling or triage skills consuming project vocabulary and ADRs | `docs/agents/domain.md` |

Cross-cutting invariants (full detail + rationale in the docs):

- Local inference (embeddings + local LLM) runs ONLY in hidden renderer hosts — never in Electron main. See ADR-0007.
- Schema/catalog changes add to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. New `packages/db` tests need no lane registration: the recursive Vitest unit-project glob discovers them, and required Unit plus nightly coverage split that one project with the same native `--shard` set. `scripts/__tests__/db-test-discovery-contract.test.mjs` guards the recursive glob and a minimum file floor.
- Every PGlite construction site loads the full engine-extension set.
- Feature gating is capability-based (does the bridge exist?) — never `isElectron()` checks in shared code. Web omits desktop-only capabilities rather than stubbing them. See ADR-0008.
- Any new persistent store/state must be wired into factory reset. See ADR-0015.
- `@mastra/core` is Node-only (its shared chunk statically imports `fs`/`child_process`/`os`) — it MUST stay externalized in browser bundles, and Mastra stays an embedded library runtime with no HTTP surface of its own. See ADR-0012.
- Non-native typed libraries build JavaScript and declarations with `tsc -b`. Use tsup only when the package produces a real bundle boundary (workers/assets, required CJS interop, or a deliberately self-contained server bundle); never add tsup just to duplicate plain library emit. Native-addon packages remain `node-gyp` builds. Packages extending `packages/config/tsconfig/node-library.json` use TypeScript's `NodeNext` mode, emit Node-compatible ESM, and use `.js` in relative source specifiers.

## Working rules (Architecture Reset, BST-1914)

These override any older directive, contract or "settled" marker that conflicts with them. "Settled" and "do not relitigate" markers in `docs/agents/` are historical evidence, not binding rulings; binding decisions live in `docs/adr/`.

Index: `docs/adr/` (0001–0017).

1. **One owner per fact.** Every fact has one durable record, one writer process and one ID, named in an ADR. A fix that needs a new alias, ID kind, backfill or reconciliation step is a design change: stop and escalate to the owner.
2. **Vendor primitive first, mature tech only.** Use the library's documented primitive before building around it. Anything experimental or pre-1.0 needs a spike that proves the capabilities you need. A workaround is a code comment with an upstream link and a removal condition.
3. **Third strike stops patching.** The third fix to the same bug class or ticket stops work: write a one-page root-cause note, get the owner's approval, then change the design.
4. **Numbers before gates.** No new scheduler, budget, throttle, retry or timeout without before/after foreground p95 from the loaded benchmark.
5. **Test the real shape.** Fixtures come from recorded runtime payloads. No test asserts prose, doc line counts, workflow YAML or source text.
6. **Red blocks the merge button.** The full regression suites are required checks. A failing spec is fixed or quarantined against an owner-held ticket. Never delete a spec to get green.
7. **Alerts must reach a human.** Every automated alert lands in Linear and is acknowledged, or the automation is switched off.
8. **Done means demonstrated.** Done is the behaviour shown working in the running app with the full regression green. "Checks green and threads resolved" is not done.
9. **One review pass.** Bots never block. Fix only owner-confirmed correctness or data-loss findings on product code, in the same PR. No tickets or PRs from bot comments.
10. **Small WIP, real tickets.** At most 3 open PRs. Follow-ups amend the original PR. A ticket is a user-visible outcome, not a slice, finding or proof.
11. **Docs are not a per-PR tax.** AGENTS.md stays under 150 lines, and real decisions go in `docs/adr/`. No exact line pins, and no requirement to edit docs alongside code.
12. **Guards need an incident.** A new guard links the real defect it would have caught. Never write a guard that checks another guard.
13. **Spike before fleet.** Engine swaps, migrations, CI systems and agent fleets start as a spike of at most two days, with the owner's written go/no-go before fan-out. Scheduled automation that opens PRs or issues, other than failure alerts under rule 7, stays off until v1.
14. **Release is the critical path.** Until v1 ships: release first, then red-suite fixes. Everything else needs the owner's explicit yes.

## Stack & style

- Effect 4 is part of the essential runtime stack for typed boundaries and structured resource ownership; follow the Effect boundary contract above for version pins, Promise APIs, preload exclusion and deferred subsystems. Read `packages/effect-kit/node_modules/effect/AGENTS.md` completely before writing Effect code; the repository contract takes precedence.
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
