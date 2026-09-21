# Agent contract idiom

How every `docs/agents/<area>.md` is written. `AGENTS.md` routes an agent to a
**contract**; the agent reads the whole contract before touching that area, so
every line is paid for on every task.

## Two tiers

| Tier | Path | Read when | Holds |
| --- | --- | --- | --- |
| **Contract** | `docs/agents/<area>.md` | Before any change to the area | The rules that are true now |
| **Evidence** | `docs/agents/<area>/<topic>.md` | Before proposing to change a settled rule, or when debugging that topic | Why the rule exists: incidents, measurements, rejected alternatives, prior designs |

## Contract sections

Present tense, imperative, checkable. One topic per `###` heading, shaped:

```markdown
### <Topic>

- <Rule an agent can obey or verify.>
- <Rule.> Why: <one clause, only when the rule looks wrong without it>.

Settled: <ruling that stays closed>. Evidence: `<area>/<topic>.md`.
Guard: `<test or script that fails when the rule breaks>`.
```

- State the current behaviour only. A design that was replaced belongs in evidence.
- Name the guard. A rule with a guard needs less prose; the test is the detail.
- Keep a heading's words stable: code comments cite sections by name.
- Ticket IDs and PR numbers live in evidence, where they explain something.

## What moves to evidence

Anything answering *"how did we learn this?"*: dated incidents, PR and run
numbers, byte counts and timings, "previously…" designs, rejected alternatives,
trust-model arguments, vendor links. Evidence files open with the rule they
support, then the record. They are historical once written — correct a wrong
fact, otherwise append.

## What is deleted

Text that restates its source of truth: what a workflow, config, script, or test
already says line by line. Point at the file; it cannot go stale.

## Adding knowledge

A new rule is one or two contract lines plus a guard. Its story goes in an
evidence file in the same change.

`scripts/__tests__/agent-contract-budget-contract.test.mjs` pins every contract
to an exact line count, so a new rule is normally paid for by moving at least as
much material out to evidence. Both directions fail:

- **Growth** fails. The fix is to move material to evidence, not to raise the
  number.
- **Shrinking** fails too, naming the new count — including when an unrelated
  change deletes a stale line. Lower the pin in the same commit; a tolerance
  band would let those lines be added back later while still passing.

When a contract legitimately must grow (a genuinely new subsystem area, or
restoring a rule that was wrongly cut), re-baseline the pin in the same commit
and say why in the commit message. The number moves on purpose, never silently.
A new contract file is registered in `CONTRACT_LINE_BUDGETS` in the commit that
adds it. Generated or `_`-prefixed docs are not contracts and carry no pin.

The same test checks the back-reference graph, which is the part most likely to
rot: every evidence file names a section its contract actually has, and every
`<area>/<topic>.md` pointer resolves.
