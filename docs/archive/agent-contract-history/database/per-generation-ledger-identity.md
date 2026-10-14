# Per-generation ledger identity — evidence

Supports `docs/agents/database.md` § "Per-generation ledger identity".

Why the delegation ledger is scoped to a generation rather than a parent run (BST-1749, PR #3198 review item 5; owner ruling 2026-09-15), how `generation_run_id` is derived on each leg, what NULL means, and the asymmetric cost of the throw to the two consumers. Read before changing generation derivation or the upgrade cohort's refusal.

The record below is the original contract text, extracted unchanged.

`custom-140-assistant-native-runs` adds `generation_run_id` to
`brainstrike_assistant_thread_runs` and creates
`brainstrike_assistant_native_runs`, the mapping from a native (Mastra) ROOT run
to the host leg that started it. Both exist so the delegation ledger is scoped to
a GENERATION — the initial send or regeneration that opened it — instead of to a
single parent run (BST-1749, PR #3198 review item 5; owner ruling 2026-09-15).
One turn spans SEVERAL native runs because each idle-loop continuation mints a
fresh Mastra run id, so a per-run identity gave every leg of a turn its own
ledger row and left the earlier one unsuperseded on reload.

`generation_run_id` is stamped by `createThreadRun` — the sole minting site —
and never rewritten: an initial or regeneration leg references itself, and a leg
that answers a decision inherits the generation of the leg whose paused run it
continues (a child continuation through its receipt, a DELEGATED pause through
its invocation's `host_run_id`, a ROOT-OWN pause through the native run mapped
here). Rows that predate the migration are backfilled to their OWN id: a
generation opened before 140 is one leg as far as the ledger is concerned. NULL
means nothing mapped that leg's paused run — a pause parked before 140, a
surface that maps no native runs, or a delegated child run header — and
`readBackgroundGeneration` throws there rather than invent an identity, so a
hand-seeded host leg in a test must declare its generation exactly as
`createThreadRun` would. The two consumers differ in what that throw costs, and
the upgrade cohort feels only the second: `createLedgerPublisher.publish`
catches a failed read and logs `background_ledger_read_failed`, so the leg
survives and merely loses that status row, while the resume path calls
`requireBackgroundGeneration` eagerly before sibling answers are recorded or
native resume begins. A task parked BEFORE migration 140 is therefore refused
without consuming the user's claim or changing any parked sibling. The typed
refusal keeps the bounded `background-generation-unmapped` reason. Both the
live-decision 409 and the cold approval stream initializer carry its actionable
public message to Stop or cancel the pending work, then start a new request.
The host never guesses a generation or automatically replays unknown effects;
a fresh user request follows the normal self-generation path.

The mapping is FIRST-WRITER-WINS: an approval leg re-streams the very run it
resumed, so the row keeps the leg that STARTED it, and a run already mapped under
a different generation is rejected rather than silently re-parented. Rows
reference `brainstrike_assistant_thread_runs` with `ON DELETE CASCADE`, and host
runs cascade from `mastra_threads`, so the table sits in `RESET_EXCLUDED_TABLES`
with that reason and needs no clear-path entry. Paired:
`migration-140-assistant-native-runs.integration.test.ts` (DDL, the
backfill-to-own-id upgrade, cascade, constraint rejection, replay and rollback),
the `background generation ports (migration 140)` cases in
`delegated-generation-ports.integration.test.ts` (both ports plus every
derivation branch over real invocation, continuation and mapping rows, the
NULL-generation no-write refusal, and fresh-generation recovery), `background-ledger.spec.ts`,
`background-idle-loop.spec.ts` and
`background-ledger-generation.integration.spec.ts` (one ledger id across a turn's
legs, plus early refusal, claim release, and no sibling-answer write),
`decide-endpoint.test.ts` (actionable live 409 transport),
`stream-init-tool-budget.test.ts` (cause-wrapped cold approval transport and its
generic-error negative matrix), and
`assistant-run-schema-upgrade-path.test.ts`, whose
bootstrap-convergence control now expects exactly this column to differ.

## NULL as absence and single-row reads (BST-1749, PR #3274)

Because `readBackgroundGeneration` throws on NULL, a hand-seeded host leg in a
test declares its generation exactly as `createThreadRun` would.

A leg whose `generation_run_id` is unset maps no native run: `recordNativeRootRun`'s
`current_run` CTE filters `generation_run_id IS NOT NULL`, so the leg refuses with
`host-scope-invalid`. The same-generation join then compares with `=` rather than
`IS NOT DISTINCT FROM`. That operator choice is hardening, not a guarded behaviour:
with the CTE filter in place `current_run.generation_run_id` is never NULL, so both
operators agree on every reachable input — reverting it leaves every
generation-port case green. What the tests pin is the reachable half: two legs
with no generation are never one generation, and neither maps a run
(`delegated-generation-ports.integration.test.ts`); removing the CTE filter
reddens it.

`resolveGenerationRunId`'s three reads each match by primary key —
`native_run_id`, a continuation's `id`, and an invocation's
`(root_thread_id, parent_runtime_run_id, parent_tool_call_id)` (migration 127's
`PRIMARY KEY`) — joined to the owner leg by `id`. `readSoleGenerationRunId`
throws on a second row instead of taking `rows[0]` of an unordered result, which
would pick a generation arbitrarily (`generation-run-id-read.test.ts`).

