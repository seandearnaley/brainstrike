# Agent DevTools profile isolation and the ownership marker — evidence

Supports `docs/agents/platform-contracts.md` § "AGENT DEVTOOLS PROFILE ISOLATION".
Read before changing the `dev:agent-debug` profile path, its ownership marker, or its sweep. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
The official `dev:agent-debug` launcher owns a temporary Electron profile for
each run. When Agent DevTools is enabled, desktop startup MUST apply the
launcher's absolute `BRAINSTRIKE_E2E_USER_DATA_DIR` to both Electron `userData`
and its nested `sessionData` path before any store or window is created. A
missing path fails startup; it must never fall through to the production
profile. This path isolation does not enable E2E runtime semantics: live
provider, storage, and single-instance behavior remain production-equivalent.

Each profile carries an `agent-devtools-owner.json` marker naming the owning
launcher pid **and its detached process group**, so a later run can distinguish
a profile abandoned by an abrupt kill from one still being written to. Because
`pnpm dev` is spawned detached, a dead launcher pid alone does not mean the
profile is idle — the tree survives SIGKILL of its launcher. The sweep never
deletes a profile it cannot prove is dead, and never fails a launch. Full
contract in `docs/agents/ci-quality.md`.

Desktop E2E is a separate mechanism and not part of this contract: the
Playwright fixture derives its own `brainstrike-test-user-data-*` path and owns
its teardown. It must never adopt the `brainstrike-agent-devtools-` prefix,
which would expose its profiles to the launcher's sweep.
