# ADR-0010: Approval grants, delegation and restart behaviour

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914

## Context

Approval state had 88 representations and took 192 PRs. During BST-1749 the owner
ruled on grant, wake and delegation semantics after concrete failures: a symmetric
"stricter wins" ceiling froze every admitted child `ask`, so a grant never ended the
prompting (2026-09-12); a child's suspension woke the parent model (ruled out
2026-09-14); and a parent wakeup is the whole ledger, not one line per event
(2026-09-15). The reset moves these behaviours onto the host's child-run manager; the
subagent spike passed 178 tests with 33 of 33 mutations caught.

## Decision

- **Grants.** Tools carry one of four risk categories: `read`, `edit`, `execute`,
  `mcp`. "Allow all tools this session" is four category grants, never a session-yolo
  flag, and each category stays individually revocable. A per-tool DENY beats any
  grant. A grant is recorded before the pending call resumes, so the same resumed leg
  sees it, and the optimistic lock key is an identity.
- **Delegation.** Read-only children cannot delegate. A root grant made after
  admission lifts an admitted child `ask` on the next resume leg, a later root
  reduction still applies, and the admitted tool catalog stays frozen. After a live
  session grant, the next gated call of every child in the leg runs without asking.
- **Wakeups.** A child's suspension never wakes the parent model. A parent wakeup is
  the whole ledger of the turn's background invocations, read from durable rows. An
  interrupted claim is terminal, and admission never asserts that an effect succeeded.
- **Restart.** Top-level approvals, questions and plans survive, and once answered the
  action runs at most once: if the app dies while it runs, it is marked interrupted and
  never re-run. Child interactions are marked interrupted. An approval whose input was
  redacted is interrupted too, because its secret was never stored.

## Consequences

- An approval becomes a requested/responded event pair in the run log (ADR-0011), and
  the UI reads the tool part's approval state.
- An approval answered just before a crash finishes at startup. A second answer to the
  same approval is refused.
- A pending child approval does not survive a restart; it shows as interrupted. Of
  the products surveyed, Goose and LobeHub store pending approvals as records; most
  others lose them on restart.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `docs/agents/assistant-runtime.md:1647` (four category grants), `:1778` (policy
  snapshot, lock identity).
- `docs/agents/assistant-subagents.md:35` (read-only children), `:1544` (grant after
  admission), `:1133` (session grant stops asking), `:1004` (suspension never wakes the
  parent), `:1011` (wakeup ledger), `:666` (interrupted claim is terminal).
- Restart behaviour: the architecture reset report (2026-10-01), "Approvals across a
  restart".
