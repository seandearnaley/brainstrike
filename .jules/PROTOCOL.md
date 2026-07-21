# .jules/PROTOCOL.md — Night Shift fleet doctrine (v1)

Every scheduled maintainer reads this file at wake. It overrides your charter
where they conflict. Repository instructions (AGENTS.md, docs/agents/*)
override both.

Pre-existing loops (bolt, sentinel, palette) keep their own conventions until
their charters are migrated to this protocol; new loops follow it from day one.

## Identity & state

- Your name, scope, and authority come from your charter. You have no memory
  of previous runs. All state you may rely on lives in, in trust order:
  open PRs under your name → repository HEAD → your Linear state issue
  (`[automation-state] <Name>`, label `night-shift`) → nothing.
- State checkpoints are APPEND-ONLY comments on your state issue:
  `<UTC-ISO> | watermark=<sha> | status=<NOOP|PR|BLOCKED> | <one line>`.
  Never edit the issue description or prior comments.
- Watermark discipline: your state issue's latest checkpoint holds the last
  main SHA you fully swept. At wake, diff `<watermark>..origin/main`. Empty
  range + no open PR of yours + no reopened ticket of yours → append a NOOP
  checkpoint and exit. NOOP is success.

## Findings & tickets (Linear)

- Every finding gets a stable fingerprint: `<loop>:<subsystem>:<symbol-or-
  path>:<mechanism>`. Before filing anything, search Linear for the
  fingerprint (it appears verbatim in the ticket body). Found & open →
  update that ticket, never file a twin. Found & closed → reopen only if
  the relevant code hash changed since closure.
- Ticket labels: `night-shift`, `loop:<name>`, plus severity. Escalations
  that block you get `needs-human` and a checkpoint with status=BLOCKED.

## Learnings

- `.jules/<name>.md` is yours. Read ALL of `.jules/*.md` at wake; write only
  your own. Entries are durable, codebase-specific, and consolidated —
  no run logs, no timestamps-as-content, no generic advice.
- A learning lands in the same PR that established it. Loops without PR
  authority append learnings to their state issue under `## pending-learnings`;
  the Librarian loop periodically moves those into `.jules/` via one PR.
- Cross-loop observations go to `.jules/bulletin.md` as
  `- [from:<name> <date>] <one sentence> → <who should care>`.
  Cap 40 lines; when full, consolidate or delete stalest first.

## Hard rules (all loops)

- Never merge, enable auto-merge, deploy, migrate schemas, touch live data,
  weaken an assertion/threshold/timeout, or add a retry to make CI pass.
- One open PR per loop, ever. Resume it or close it before starting another.
- Branch naming: `night-shift/<name>/<fingerprint-slug>`.
- Re-derive every command, path, and enumeration from the repo at wake.
  Anything memorized in a charter or learning is a hint, not a fact.
- Labels on GitHub PRs: only the `review/*` namespace (owned by Assay) and
  never the functional `coverage` label. No workflow may ever consume a
  `review/*` label — docs/agents/ci-quality.md forbids CI routing labels.
- Budget: note UTC time at wake; check it only at phase boundaries. On
  expiry: stop subagents, append a checkpoint with exact next action, exit
  BLOCKED or INCOMPLETE. An out-of-scope-but-valuable discovery is never
  dropped — it becomes a Linear backlog ticket with evidence attached.
