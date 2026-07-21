# .night-shift/PROTOCOL.md — Night Shift fleet doctrine (v1)

Every scheduled maintainer reads this file at wake. It overrides your charter
where they conflict. Repository instructions (AGENTS.md, docs/agents/*)
override both.

All loops — including the migrated bolt, sentinel, and palette — follow this
protocol; their charters in charters/ are the deployed source of truth.

## Identity & state

- Your name, scope, and authority come from your charter. You have no memory
  of previous runs. All state you may rely on lives in, in trust order:
  open PRs under your name → repository HEAD → your Linear state issue
  (`[automation-state] <Name>`, label `night-shift`) → nothing.
- State checkpoints are APPEND-ONLY comments on your state issue:
  `<UTC-ISO> | watermark=<sha> | status=<NOOP|PR|BLOCKED> | <one line>`.
  Never edit the issue description or prior comments.
- Watermark discipline. Every loop records what it last processed and, at
  wake, does the cheapest check that proves there is nothing new before doing
  real work. The watermark's SHAPE depends on where your work comes from:
  - MAIN-DIFF loops (axiom, scribe, ledger, warden, pruner, quartermaster,
    bolt, sentinel, palette) watch the code on `main`. Watermark = last main
    SHA fully swept. At wake, diff `<watermark>..origin/main`; empty range +
    no open PR of yours + no reopened ticket of yours → NOOP checkpoint and
    exit.
  - EXTERNAL-STATE loops watch something other than the main diff and must
    NOT exit just because `main` didn't advance — their inputs change on a
    different clock. Assay/Magnify watch open-PR heads (watermark = set of
    `<pr,head-sha>` already processed); Watch watches workflow-run IDs;
    Sweep watches its open ticket set. Each exits NOOP only when ITS own
    watched set is unchanged since last run, never on the main diff.
  In all cases: an unchanged watched set means NOOP, and NOOP is success.

## Findings & tickets (Linear)

- Every finding gets a stable fingerprint: `<loop>:<subsystem>:<symbol-or-
  path>:<mechanism>`. Before filing anything, search Linear for the
  fingerprint (it appears verbatim in the ticket body). Found & open →
  update that ticket, never file a twin. Found & closed → reopen only if
  the relevant code hash changed since closure.
- Ticket labels: `night-shift`, `loop:<name>`, plus severity. Escalations
  that block you get `needs-human` and a checkpoint with status=BLOCKED.

## Learnings

- `.night-shift/<name>.md` is yours. Read ALL of `.night-shift/*.md` at wake; write only
  your own. Entries are durable, codebase-specific, and consolidated —
  no run logs, no timestamps-as-content, no generic advice.
- A learning lands in the same PR that established it. Loops without PR
  authority append learnings to their state issue under `## pending-learnings`;
  the Librarian loop periodically moves those into `.night-shift/` via one PR.
  INTERIM (until the Librarian ships — see charters/README.md Wave 2): the
  diagnose-only loops (assay, watch, magnify) have no automated path from
  `pending-learnings` into the tracked `.night-shift/*.md` files, so their
  durable learnings live only on their Linear state issues meanwhile. This
  is expected, not a bug; a human or any PR-authoring loop may hand-migrate
  a high-value entry sooner.
- Cross-loop observations go to `.night-shift/bulletin.md` as
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
