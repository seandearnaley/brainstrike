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
  `<UTC-ISO> | watermark=<sha> | status=<NOOP|PR|READY|INCOMPLETE|BLOCKED> | <one line>`.
  Never edit the issue description or prior comments.
  PR = opened or still stewarding an open PR; READY = that PR is stable and
  ready to merge (see PR stewardship); INCOMPLETE = budget or cycle cap hit,
  the one-line message states the exact next action.
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
  In all cases: an unchanged watched set means NOOP, and NOOP is success —
  but an open PR of yours is ALWAYS part of your watched set: while it has
  failing checks, unreplied review comments, or unresolved threads, you are
  not idle (see PR stewardship).

## PR stewardship (any loop with an open PR)

Opening a PR is the midpoint of your job, not the end. A PR abandoned after
open — bot reviews unanswered, threads dangling — is worse than no PR: it
costs the human triage time and poisons trust in every other loop's PRs.

- Stewardship precedes new work. At wake, before any discovery, reconcile
  your open PR: fetch required-check status and ALL review threads on the
  current HEAD (`gh pr view`, and `gh api graphql` for reviewThreads —
  thread resolution state is not visible through plain `gh pr view`).
- EVERY review comment gets a reply, bots included. The reply is one of:
  the fixing commit SHA, a concise reasoned decline, or a link to the
  follow-up Linear ticket. Never leave a comment unanswered, and never
  reply with content-free acknowledgments.
- After replying, resolve the thread via `gh api graphql`
  (`resolveReviewThread`) when the concern is genuinely addressed — fixed,
  answered, or ticketed. Never resolve a thread whose question is still
  open, and never resolve a human's thread without your reply visible.
- Feedback that is real but out of your scope or too large for this PR →
  fingerprinted Linear ticket (normal ticket rules), linked in your reply,
  then resolve the thread. Deferral must leave a trail, not a dangling
  thread.
- Failing checks on your HEAD are yours: diagnose and fix, batching known
  fixes into one push. Checks failing for external reasons (infra outage,
  unrelated main breakage) → `needs-human` ticket + checkpoint BLOCKED;
  do not churn retries against an external failure.
- Repeat the reconcile after every push. The PR is stable only when, for
  one HEAD simultaneously: required checks green, every thread replied AND
  resolved, working tree clean. Then checkpoint `status=READY` and hand
  off. Cap of six fix/push cycles per run; on hitting it, checkpoint
  `status=INCOMPLETE` with the exact next action.
- `status=READY` is per-HEAD, not permanent: new review activity or a new
  HEAD reopens stewardship at your next wake. The one-PR rule already
  blocks new work while your PR is open; stewardship is what you do with
  that time.

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

## Execution skills

- `.agents/skills/<name>-automation/SKILL.md` is your loop's repo-owned
  execution skill: bundled read-only evidence collectors and a proven step
  ordering that replace ad-hoc re-discovery. At wake, after reading this
  protocol and your charter, check for your skill and follow it when present.
- Skills sit BELOW everything else: repository instructions > contracts >
  this protocol > your charter > the skill. A skill that contradicts a
  higher authority is a bug — follow the higher authority and file a
  fingerprinted ticket for the skill defect; never silently obey the skill.
- Collector output is evidence, never verdict or permission. Collectors are
  read-only; if one appears to write anything, stop and escalate.
- PR-authoring loops use `.agents/skills/brainstrike-pr-loop` for
  stewardship mechanics (watcher, thread reconciliation, CI pruning). Its
  "Night Shift mode" section binds it to this protocol: never merge,
  reply to every comment, six-cycle cap.

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
