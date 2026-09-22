# Delegation accounting relations and the whole-profile reset proof — evidence

Supports `docs/agents/platform-contracts.md` § "Delegation resource accounting reset".
Read before changing the delegation budget relations or the desktop delegated-reset E2E. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
Migration 132's `brainstrike_delegation_budgets`,
`brainstrike_delegation_child_budgets` and
`brainstrike_delegation_step_reservations` belong to the application database.
Both direct-transport reset paths and desktop IPC reset clear them, and the
shared reset registry classifies all three. There is no separate persistent
queue or filesystem accounting store. Native host shutdown drains active work
before reset; unresolved output remains charged on ordinary restart.

`delegated-factory-reset.desktop.test.ts` exercises Settings Cancel and confirmed
factory reset against 14 populated, migrated relations: native thread/message
history, delegated ancestry/invocations/decisions, host runs/events, root/child
budgets and step reservations, continuations/continuation decisions, attributed
usage and saved child tabs. Cancel preserves the exact seeded records and disabled
delegation preference. Confirmed reset replaces the renderer; a subsequent full
process restart still cannot recover those identities or tabs, and the actual
Subagents switch returns to its default. A disposable user workspace outside the
profile retains its file contents. This is whole-profile no-resurrection coverage,
not a replacement for table-by-table `db:clearAll` integration proofs. The seeded
completed continuations and consumed decisions are durable-state fixtures, not
claims that an active native worker was stopped by this particular test.
