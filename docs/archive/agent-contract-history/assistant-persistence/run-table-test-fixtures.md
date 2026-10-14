# Run-table test fixtures — evidence

Supports `docs/agents/assistant-persistence.md` §
"Test fixtures are not a licence to reshape these tables". Read this before proposing to change a fixture that stands up its own copy of the run header.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Three suites used to stand up their own copy of the run header because the
chain did not create it, and all three dropped the `thread_id` foreign key or
most of the column set to keep the fixture small — a fourth schema authority,
below the mirror the ticket set out to remove, and the reason the FK looked
"new" when 118 landed. It is not new: the run header has carried
`brainstrike_assistant_thread_runs_thread_id_fkey` since it first shipped
(2026-06-20). Seed a `mastra_threads` parent row; never re-declare the table.

Do NOT confuse these with `brainstrike_assistant_run_outcomes`, which has been
migration-backed since 062.

`pr.opened` / `pr.checks` / `pr.merged` (BST-1391) are the only run-event
kinds not produced by the agent stream. They are appended to the thread's MOST
RECENT run because `run_id` is `NOT NULL`; a thread with no runs gets no
timeline row, logged at `info`. This adds no writer and no schema change.

