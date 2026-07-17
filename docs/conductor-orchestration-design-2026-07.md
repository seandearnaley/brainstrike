# Conductor — Symphony-style Work Orchestration for Brainstrike

**Status:** Design exploration (2026-07-16). Not yet an ADR.
**Upstream spec:** [OpenAI Symphony SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) (Apache-2.0, released 2026-04).
**Goal:** implement the Symphony spec's core conformance perimeter inside brainstrike, generalized across **GitHub, GitLab, Jira, and Linear**, using the app's existing contracts (capability bridges, SecretsService, dual-ledger migrations, five-registry tools, PGlite live queries).

---

## 1. What Symphony is, in one paragraph

A long-running, single-authority orchestrator that makes the **issue tracker the control plane** for coding agents: poll the tracker → claim eligible issues → materialize one sandboxed workspace per issue → launch a coding-agent session in it → run multi-turn continuation until the issue leaves an active state → retry with capped exponential backoff → reconcile against tracker state every tick. Policy lives in a repo-owned `WORKFLOW.md` (YAML front matter + Liquid prompt) that hot-reloads with last-known-good semantics. The orchestrator keeps **no persistent state** — restart recovery is re-poll and re-derive. The spec hard-codes two integrations (Linear as tracker, Codex app-server as agent) and explicitly lists "pluggable tracker adapters" and "first-class tracker write APIs" as unspecified extensions.

## 2. The shape of the brainstrike implementation

Working name: **Conductor**.

Three deliberate generalizations over the reference spec, each replacing a hard-coded integration with a port:

| Symphony hard-codes | Conductor port | Adapters |
| --- | --- | --- |
| Linear GraphQL client | `TrackerAdapter` | Linear, GitHub, GitLab, Jira |
| Codex app-server protocol | `AgentRunner` | ACP (Claude Code, Codex CLI, Gemini CLI, 25+ agents), later: brainstrike's bespoke agent (ADR-0001) |
| Optional HTTP dashboard | In-app renderer panel via PGlite live queries + IPC | Optional loopback HTTP server kept for spec conformance |

Everything else — the poll/dispatch/reconcile loop, claim states, retry queue, workspace safety invariants, `WORKFLOW.md` semantics, continuation turns — is implemented **spec-faithfully** so the conformance test matrix in the spec maps 1:1 onto our test suite. Deviations are enumerated in §13.

### Architecture: functional core, imperative shell

- **`packages/conductor-core`** — pure TypeScript, zero I/O: workflow loader/parser, typed config, prompt rendering, the orchestration **reducer** (events in → next state + planned effects out), domain types. This is where the spec's entire "Core Conformance (REQUIRED)" matrix is unit-tested.
- **`packages/tracker-adapters`** — the `TrackerAdapter` contract + one module per provider. Thin typed clients over `fetch` + Zod normalization. Integration tests use the repo's `*.integration.test.ts` convention (env-key-gated), which maps exactly onto the spec's "Real Integration Profile."
- **`apps/desktop/src/conductor/`** — the imperative shell: service lifecycle, timers, file watcher, workspace manager (FS + git worktrees via the existing `execFile` git service), hook runner, ACP subprocess runner, IPC domain + `window.conductor` bridge, secrets resolution.
- **`packages/db`** — run-ledger migrations (dual ledger + factory reset + test-lane manifest).

Conductor is a **desktop-only capability** (subprocess + FS + git). Per the bridge contract, web builds simply never construct the `window.conductor` bridge, so all Conductor UI/actions are hidden — no `isElectron()` checks, no stubs. It runs in the Electron main process alongside the assistant server and git IPC domain; the renderer-only rule applies to *inference*, not to a poll loop and subprocess supervision.

Why a reducer core: the spec's orchestration is a textbook event-driven state machine (`tick`, `worker_exit`, `retry_due`, `config_changed`, `tracker_snapshot` → dispatch/terminate/schedule/clean effects). A pure reducer with an effects interpreter matches the repo's existing TDD'd-reducer idiom, makes stall/backoff/claim logic deterministic to test, and keeps every side effect (timer, subprocess, FS) in one small host file.

## 3. Domain model

### Normalized WorkItem

Superset of the spec's normalized Issue, with a provider discriminant and a two-level state:

```ts
export type TrackerKind = 'linear' | 'github' | 'gitlab' | 'jira';

export type WorkItemStateCategory =
  | 'triage' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled';

export interface WorkItemState {
  /** Provider state name — what WORKFLOW.md active/terminal sets match on (spec semantics). */
  name: string;
  /** Normalized category for defaults, blocker gating, and UI. Null when unmappable. */
  category: WorkItemStateCategory | null;
}

export interface WorkItem {
  tracker: TrackerKind;
  id: string;                 // provider-opaque stable id
  identifier: string;         // human key: ABC-123 / #482 / PROJ-9 / owner/repo#12
  title: string;
  description: string | null; // markdown-normalized
  state: WorkItemState;
  priority: number | null;    // normalized 0 (none) … 4; adapter-mapped
  labels: readonly string[];  // trimmed, lowercased (spec rule)
  blockedBy: readonly BlockerRef[];
  branchName: string | null;  // provider hint (Linear native) or derived
  url: string;
  createdAt: string;          // ISO-8601
  updatedAt: string;
}
```

The two-level state is the key multi-provider move. `WORKFLOW.md` keeps matching on raw **state names** (spec-conformant), while `category` gives cross-provider semantics where the spec hard-codes Linear conventions (e.g. its "`Todo` issues with non-terminal blockers are ineligible" rule generalizes to "states whose category is `todo`/`triage`", overridable via config).

### Capability matrix — no silent fallbacks

The four trackers genuinely differ. Following the repo's capability-gating ethos (a bridge's *presence* adds a capability; nothing is stubbed), every adapter declares what it can do, and **config validation fails loudly** when a workflow requires something its tracker can't express:

```ts
export interface TrackerCapabilities {
  states: 'native' | 'mapped' | 'binary';   // Linear/Jira native; GitHub/GitLab need mapping
  blockedBy: 'native' | 'unsupported';
  priority: 'native' | 'labelDerived' | 'unsupported';
  branchNameHint: boolean;
  writeComment: boolean;
  writeStateTransition: boolean;
}
```

Provider reality check (verify exact API shapes at implementation time):

| | states | blockedBy | priority | notes |
| --- | --- | --- | --- | --- |
| **Linear** | native (state `type`: triage/backlog/unstarted/started/completed/canceled) | native (inverse "blocks" relations) | native 0–4 | GraphQL, cursor pagination; the spec's reference target |
| **Jira** | native (`statusCategory`: new/indeterminate/done + named statuses) | native ("Blocks" issue links) | native | REST v3; use the current `/rest/api/3/search/jql` endpoint (`nextPageToken` pagination — the legacy `/search` was deprecated in 2025); JQL is the candidate filter |
| **GitHub** | **mapped** (open/closed + config-declared mapping via labels or Projects-v2 single-select status field, GraphQL) | native (issue dependencies blocked-by/blocking, shipped 2025) | labelDerived or Projects field | GraphQL preferred; honor rate-limit headers |
| **GitLab** | **mapped** (open/closed + scoped-label convention, e.g. `workflow::in progress`) | native on Premium ("blocks/is blocked by" links) — surface 403 visibly on Free, never degrade quietly | labelDerived | REST with keyset pagination; support self-managed `host` |

### Tracker adapter contract

The spec's three REQUIRED read ops, plus first-class writes (the spec lists writes as a recommended extension; Conductor makes them core because "tracker as control plane" needs a feedback loop):

```ts
export interface TrackerAdapter {
  readonly kind: TrackerKind;
  readonly capabilities: TrackerCapabilities;

  // Spec-required reads
  fetchCandidateIssues(q: CandidateQuery): Promise<readonly WorkItem[]>;
  fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly WorkItem[]>;
  fetchIssueStatesByIds(ids: readonly string[]): Promise<readonly WorkItemStateSnapshot[]>;

  // Capability-gated writes (throw TrackerCapabilityError if undeclared)
  postComment(id: string, bodyMarkdown: string): Promise<void>;
  transitionState(id: string, toStateName: string): Promise<void>;
}
```

Rules: all outputs Zod-validated at the boundary; pagination handled inside the adapter (spec default page size 50); network timeout 30 s; rate-limit `Retry-After` honored; errors are typed (`transport` / `auth` / `not_found` / `malformed`) so the orchestrator's failure classes (§ spec "Failure Model") stay provider-agnostic. **NO SILENT FALLBACKS** — a 403 on GitLab blocker links or a missing Projects field is a surfaced, logged error, never a quiet `[]`.

### Control plane vs agent plane

Deliberate split:

- **Control plane (the orchestrator's own loop)** uses the typed adapters directly — deterministic, schema-validated, retry-aware, no token budgets. MCP indirection here would add nondeterminism for zero benefit.
- **Agent plane (what the dispatched coding agent can call)** reuses existing seams: attach the provider's MCP server (GitHub/Atlassian/Linear all ship one) via the existing MCP transport config, and/or expose a single native `brainstrike.trackerRequest` tool that generalizes the spec's optional `linear_graphql` extension — normalized `postComment`/`transitionState` operations through Conductor's already-configured auth, so the agent never handles raw tokens. Raw GraphQL escape hatch stays optional and off by default.

## 4. Agent runner port

```ts
export interface AgentRunner {
  startSession(ws: Workspace, meta: SessionMeta): Promise<AgentSession>;
  runTurn(s: AgentSession, prompt: string, opts: TurnOptions): AsyncIterable<AgentEvent>;
  stopSession(s: AgentSession): Promise<void>;
}
```

- **Primary adapter: ACP over stdio.** Since Symphony shipped, the Agent Client Protocol became the cross-vendor standard (JetBrains, Zed, Neovim, Microsoft Intelligent Terminal; 25+ agents including Claude Code and Codex CLI). Speaking ACP makes Conductor agent-agnostic the same way `TrackerAdapter` makes it tracker-agnostic — and Codex CLI itself speaks ACP, so spec-parity with the Codex reference is preserved through the same adapter. Session identity maps to the spec's `session_id = "<thread_id>-<turn_id>"` from ACP session/turn ids.
- **Later adapter: the bespoke brainstrike coding agent** (ADR-0001). Once the in-app agent loop lands, an issue-driven dispatch of it shares the permission engine, run-usage accounting, and personas. This is v2 — it must not block v1.
- **Timeouts** exactly per spec: `read_timeout_ms` (5 s), `turn_timeout_ms` (1 h), `stall_timeout_ms` (5 min, ≤0 disables) enforced by the orchestrator from event inactivity.
- **Approval posture** (spec: implementation-defined, MUST document): default is autonomous with the workflow's declared sandbox/approval config passed through ACP. Where the reference impl fails `turn_input_required` turns, Conductor **routes them to the app's run-notification surface** as actionable items with a configurable timeout-to-fail. Unsupported tool calls return protocol-level failure and continue (no stall), per spec.

## 5. Orchestrator core (spec-faithful)

Implemented in `conductor-core` as a reducer over:

- **Claim states:** Unclaimed → Claimed (Running | RetryQueued) → Released.
- **Run-attempt phases:** PreparingWorkspace → BuildingPrompt → LaunchingAgentProcess → InitializingSession → StreamingTurn → Finishing → {Succeeded, Failed, TimedOut, Stalled, CanceledByReconciliation}.
- **Tick:** reconcile running (stall check + state refresh) → validate dispatch config (invalid: skip dispatch, keep reconciling, keep last-known-good) → fetch candidates → sort (priority, createdAt, identifier) → dispatch while global and per-state slots free → notify observers.
- **Eligibility:** active ∧ ¬terminal ∧ all required_labels ∧ ¬running ∧ ¬claimed ∧ slots free ∧ (category todo/triage ⇒ no non-terminal blockers).
- **Retry:** continuation 1 s fixed after normal exit; failures `min(10_000 · 2^(attempt−1), max_retry_backoff_ms)`; on retry-due re-fetch candidates, release claim if missing/inactive, requeue with "no available slots" if saturated.
- **Continuation semantics:** after each successful turn, re-check tracker state; still active → next turn on the same live session (≤ `max_turns`), first turn full rendered prompt, continuation turns guidance-only.
- **Startup:** validate dispatch config or fail startup; terminal-workspace sweep (warn-and-continue on fetch failure); schedule tick 0.

## 6. Workspaces

- Layout, sanitization (`[^A-Za-z0-9._-]` → `_`), and the three safety invariants (agent cwd = workspace; workspace under root after normalization; sanitized key) exactly per spec, enforced **before** agent launch.
- **Strategy extension:** `workspace.strategy: 'dir' | 'worktree'`. The spec leaves population to hooks; first-class git-worktree materialization (via the existing `execFile`-based git service — never a shell) is the 2026 idiom for per-issue isolation and cheap cleanup, and matches how brainstrike already runs its own Claude sessions. `'dir'` + hooks remains the conformance baseline.
- **Hooks** per spec: `after_create` (fail ⇒ abort creation), `before_run` (fail ⇒ abort attempt), `after_run` / `before_remove` (fail ⇒ log, ignore), all with `hooks.timeout_ms`, cwd = workspace, output truncated in logs.

## 7. Configuration — `WORKFLOW.md`

Spec format kept verbatim (YAML front matter + Liquid body, strict variables/filters via liquidjs `strictVariables`/`strictFilters`; unknown variable ⇒ fail the run attempt). Extensions:

1. **`tracker` becomes a Zod discriminated union on `kind`:**

```yaml
tracker:
  kind: github
  owner: seandearnaley
  repo: brainstrike
  auth: $secret:github            # OS-keychain indirection (see below)
  state_mapping:                   # REQUIRED for capabilities.states === 'mapped'
    source: labels                 # or: projects_v2 field name / gitlab scoped label prefix
    map: { "status: todo": Todo, "status: in progress": In Progress, "status: done": Done }
  active_states: [Todo, In Progress]
  terminal_states: [Done, Closed]
```

   Config validation cross-checks the workflow against the adapter's `TrackerCapabilities` and **fails loudly** (per-field diagnostics) when e.g. `state_mapping` is missing for a mapped-state tracker or `required_labels` reference an unsupported feature. Invalid hot-reload keeps last-known-good + surfaces an operator-visible error event (spec rule), rendered in the Conductor panel — not just a log line.

2. **`$secret:<name>` indirection** alongside the spec's `$VAR` env resolution. Desktop resolves through the existing `SecretsService` (Electron `safeStorage` → OS keychain, `encryption_unavailable` throws — no plaintext fallback). Tokens are resolved host-side, never logged, never surfaced to the model. `$VAR` stays supported for spec conformance and CI.

3. **Hot reload** via file watch: re-parse, re-validate, atomically swap; applies to future dispatch/retry/reconciliation decisions; in-flight sessions untouched (spec contract).

## 8. Persistence — the run ledger

The spec mandates **no persistent orchestrator state**, and Conductor honors that for *authority*: claims, retry timers, and running maps are in-memory; restart recovery is terminal sweep + fresh poll.

Separately, Conductor appends every run attempt and session-usage sample to a **run ledger** — `brainstrike_conductor_runs` (+ optionally `brainstrike_conductor_events`) — which is **never read by dispatch logic**. This is the ledger-native strategy (cost/outcome per task, Context Observatory) landing in its natural home: issue id/identifier, tracker kind, attempt, phase outcome, error class, wall time, token counters, session ids.

Wiring per contracts:
- Dual migration registration (numbered `packages/db/src/migrations/NNN-conductor-runs.ts` **and** drizzle `customMigrations`), `CREATE TABLE IF NOT EXISTS`, `brainstrike_*` prefix.
- New `packages/db` tests registered in `dbUnitLaneDefinitions` (test-lane manifest).
- Factory reset: purge tables in the desktop reset pipeline (`factory-reset-helpers.ts` path).
- Dashboard reads it through PGlite **live queries** (the `live` extension is already loaded at every construction site) — the panel updates in real time with zero new IPC polling.

## 9. Observability & UI

- **Structured logs** per spec: `issue_id`, `issue_identifier`, `session_id` context on every event, `key=value` format, via the app's logger (no console).
- **In-app Conductor panel** (primary status surface): running sessions with turn counts, retry queue with due times, token totals, rate-limit snapshots — in-memory snapshot over IPC + ledger live queries. Right-click/context actions follow the shared TreeTable + context-action conventions.
- **Run notifications**: `turn_input_required`, repeated stalls, and config-validation failures flow into the existing assistant notification surface.
- **Optional loopback HTTP server** (`GET /`, `GET /api/v1/state`, `GET /api/v1/<identifier>`, `POST /api/v1/refresh`) kept as the spec's conformance extension, off by default, loopback-only.

## 10. Assistant tool integration (five-registry checklist)

Two native tools, registered across all five registries (`schemas.ts`, `tool-categories.ts` (+ explicit `riskCategory` for actions), `tool-descriptions.ts`, `tool-schemas-display.ts`, live registry in `assistant-tools.ts`, plus `default-instructions.ts` guidance):

- `brainstrike.conductorStatus` — read; snapshot of running/retrying/totals (self-bounded to the 2 750-token native budget with `truncated + hint`).
- `brainstrike.trackerRequest` — action, `execute` risk, permission-engine approval; normalized `postComment` / `transitionState` through Conductor's configured adapter+auth.

This lets the in-app assistant *supervise* Conductor ("what's running? nudge ABC-123 back to Todo") without owning the loop.

## 11. Security posture (spec: MUST document)

- Trust model: operator-trusted local machine; workflows and hooks are trusted config (spec stance), but hook output is truncated in logs and timeouts are mandatory.
- Filesystem: the three workspace invariants enforced pre-launch; reject out-of-root before any subprocess starts.
- Secrets: keychain-backed, `$secret:`/`$VAR` indirection only, presence-validated without printing, never in prompts or tool results.
- Agent sandboxing: passed through ACP per-agent (approval/sandbox policy fields); hardening guidance (network restriction, narrowed tool scope) documented in the panel's setup flow.
- Web: entire capability absent (no bridge) — no partially-functional web mode.

## 12. Testing

- **Core conformance matrix → `conductor-core` unit tests**, near 1:1: workflow path precedence, reload/last-known-good, defaults/`$VAR`/path expansion, strict prompt rendering, dispatch sort, blocker gating, backoff math and caps, stall→kill→retry, slot-exhaustion requeue, claim-state transitions. Pure reducer ⇒ no mocks of the thing under test.
- **Tracker adapters:** one shared contract-test kit run against all four adapters with recorded fixtures (pagination, normalization, error mapping, capability errors), plus `*.integration.test.ts` suites gated on real credentials (`BRAINSTRIKE_CONDUCTOR_TEST_GITHUB_TOKEN` etc.) — skip-report when absent, fail when explicitly enabled — matching the spec's Real Integration Profile and the repo's integration-suffix convention exactly.
- **Loop E2E:** fake in-memory tracker + scripted fake ACP agent for full dispatch→continuation→reconcile→cleanup runs; a real-agent smoke behind the integration flag.

## 13. Explicit deviations from the spec

1. **Tracker port + capability matrix** replaces Linear-only (`tracker.kind` accepts four values; spec text says "currently `linear` only" — this is the sanctioned "pluggable tracker adapters" extension).
2. **Blocker gating generalized** from the literal `Todo` state name to state *category* (configurable), since GitHub/GitLab have no state named "Todo".
3. **ACP replaces the Codex app-server protocol** as the primary agent transport (Codex remains reachable via ACP).
4. **Tracker writes are core**, not an extension (comment + transition, capability-gated).
5. **`turn_input_required` routes to in-app notifications** instead of immediate failure (timeout-to-fail preserves liveness).
6. **Run ledger** persisted for observability only — dispatch authority remains stateless per spec.
7. **In-app panel** is the primary status surface; the HTTP server is optional conformance parity.

## 14. Package layout & PR sequencing

```
packages/conductor-core/        # pure: config, loader, prompt, reducer, domain types
packages/tracker-adapters/      # contract + linear/ github/ gitlab/ jira/ + contract-test kit
apps/desktop/src/conductor/     # host: service, workspace mgr, hooks, ACP runner, IPC + bridge
packages/db/                    # migrations 0NN-conductor-runs (+ factory reset + lane manifest)
packages/app-shell/…            # panel, context actions, notifications
```

Stacked PR chain (matching the repo's usual style):

1. **PR1** — `tracker-adapters` contract + normalized model + **Linear** adapter (spec parity) + contract-test kit.
2. **PR2** — `conductor-core`: workflow loader, typed config, prompt rendering, orchestration reducer (full conformance suite).
3. **PR3** — desktop host: workspace manager + hooks + ACP runner + IPC/bridge + run-ledger migrations + factory reset.
4. **PR4** — GitHub, GitLab, Jira adapters behind the capability matrix (one PR each if diffs get large).
5. **PR5** — Conductor panel (live queries), notifications, native tools (five registries).
6. **PR6** — bespoke-agent runner adapter once ADR-0001's loop lands.

## 15. Open decisions

1. **GitHub/GitLab state mapping default** — labels (`status: *` / `workflow::*`) vs GitHub Projects-v2 status field. Recommendation: config-declared mapping with both sources supported; no implicit default (no silent fallback).
2. **Input-required posture default** — notify-with-timeout (recommended) vs spec-literal fail-fast; per-workflow override either way.
3. **v1 write scope** — comment + transition only (recommended), or also assignee/labels.
4. **Instance model** — one Conductor per `WORKFLOW.md` (spec-shaped; recommended) with multiple instances for multi-root workspaces, vs a single multi-workflow scheduler.
