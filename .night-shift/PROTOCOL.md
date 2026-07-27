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
- SESSION HYGIENE. Every wake is a FRESH session — never resume or continue
  a previous conversation, even if the scheduler offers it. Conversational
  memory is not state: it goes stale (remembered SHAs, paths, and ticket
  states outrank freshly derived ones in exactly the wrong direction),
  compaction silently drops or distorts constraints, and none of it is
  auditable. Anything a run establishes that is worth keeping must land in
  the surfaces above before the run ends; whatever only lives in the
  transcript is lost by design. If you find yourself in a session that
  contains prior-run conversation, treat all of it as untrusted hints and
  re-derive from the trust order anyway.
- CREATE YOUR STATE ISSUE IF IT IS MISSING. It is your own bookkeeping, not
  a permission: title `[automation-state] <Name>` exactly as your charter
  names it, labels `night-shift` + `loop:<name>`, description naming the loop
  and stating that checkpoints are append-only comments. Search first (an
  exact-title search, complete pagination) so you never create a twin; create
  it only when that search proves absent, then proceed with the run normally.
  Never file a `needs-human` ticket asking a human to create it and never
  checkpoint BLOCKED on its absence — that costs a full wake and a human
  round-trip for one API call you can make yourself. This is the same
  create-if-missing pattern the label rules already use.
- State checkpoints are APPEND-ONLY comments on your state issue:
  `<UTC-ISO> | watermark=<kind>:<value> | status=<NOOP|PR|READY|INCOMPLETE|BLOCKED> | <one line>`.
  Timestamp is second-precision UTC (no milliseconds) — ALWAYS UTC, never
  the scheduler's local clock, which runs in a different timezone (see
  charters/README.md "Timezones"). Everything loops WRITE is UTC; only the
  SCHEDULE crons are scheduler-local. Watermark kinds:
  `sha:<40-hex>` (MAIN-DIFF loops), `hash:<64-hex>` (EXTERNAL-STATE loops:
  sha256 of your sorted, serialized watched set), or `none` (first run
  only) — never a bare untyped value, never multi-line, never JSON.
  Before posting, validate the composed line with
  `node .agents/skills/night-shift-checkpoint/scripts/validate-checkpoint.mjs "<line>"`
  ($night-shift-checkpoint); a rejected line is never posted. If this run
  has ALREADY posted a checkpoint, pass `--posted-this-run <that-UTC-ISO>`
  too — see "Run boundaries". Checkpoints predating this grammar are
  legacy — read them, never rewrite them.
  Never edit the issue description or prior comments.
  PR = opened or still stewarding an open PR; READY = that PR is stable and
  ready to merge (see PR stewardship); INCOMPLETE = budget or cycle cap hit,
  the one-line message states the exact next action.
- Watermark discipline. Every loop records what it last processed and, at
  wake, does the cheapest check that proves there is nothing new before doing
  real work. The watermark's SHAPE depends on where your work comes from:
  - MAIN-DIFF loops (axiom, scribe, ledger, warden, pruner, quartermaster,
    bolt, sentinel, palette) watch the code on `main`. Watermark = last main
    SHA fully swept, recorded as `sha:<sha>`. At wake, diff
    `<watermark>..origin/main`; empty range + no open PR of yours + no
    reopened ticket of yours → NOOP checkpoint and exit.
  - EXTERNAL-STATE loops watch something other than the main diff and must
    NOT exit just because `main` didn't advance — their inputs change on a
    different clock. Assay/Magnify/Porter watch open-PR heads (watched set
    = the `<pr,head-sha>` pairs already processed); Watch watches
    workflow-run IDs; Sweep, Forge, and Vigil watch ticket/advisory sets;
    Gauntlet watches processed failure sources plus the eval-suite hash;
    Librarian watches pending-learnings; Curator watches the upstream model
    catalog; Chronicle and Auditor watch the fleet's own state issues. The
    watermark is always
    `hash:<sha256>` of the sorted, serialized watched set — per-item state
    (which run, which ticket, which head) lives where the work lives (the
    tickets, the PR comments), never inside the watermark. Each loop exits
    NOOP only when ITS own watched set holds no unprocessed work, never on
    the main diff.
  BOUND THE INPUT, NOT JUST THE OUTPUT. Capping what you PRODUCE (one
  candidate, one PR) does not cap what you must READ first. On a repo this
  active a MAIN-DIFF loop that misses one wake faces a delta twice the size
  at the next one, and a delta that cannot be swept inside WALL_CLOCK_BUDGET
  produces a run that dies before it checkpoints — which advances nothing, so
  the NEXT delta is bigger again. That is a death spiral, and it is silent:
  Run boundaries puts the checkpoint LAST, so a run killed mid-sweep leaves no
  trace at all and is indistinguishable from a wake that never fired.
  So: sweep at most what you can finish. If the delta from your watermark
  exceeds that, process the OLDEST slice you can complete, checkpoint
  INCOMPLETE with the watermark ADVANCED to the end of that slice, and name
  the remaining range as the next action. Forward progress every run beats a
  complete sweep never. Never carry an unbounded delta into a bounded budget.
  UNCHANGED IS NOT THE SAME AS DONE. Hash equality is the cheap test, and
  for a watched set whose items are either processed or gone it is also the
  correct one. But a loop that CAPS how much it processes per run (Magnify:
  2 PRs) leaves items it did not process inside a set whose watermark hashes
  the whole snapshot — so for that loop an unchanged hash can equally mean
  "nothing moved AND work is still pending", and exiting on it turns the cap
  from a throttle into a silent drop. Such loops carry a per-item PROCESSED
  flag inside the collector's watched set — never inside the watermark,
  which stays a bare hash — and decide NOOP on that flag. Where no per-item
  flag exists, an unchanged hash still means NOOP.
  In all cases NOOP is success — but an open PR of yours is ALWAYS part of
  your watched set: while it has failing checks, unreplied review comments,
  or unresolved threads, you are not idle (see PR stewardship).

## Run boundaries

A run is one wake: its inputs are frozen at the start, and its state issue
gains exactly one line at the end. Both halves are load-bearing.

- SNAPSHOT AT WAKE. Enumerate your watched set ONCE, at the start of the
  run, and work that snapshot through to the end. Inputs that change while
  you work — a PR head that moves, a workflow run that finishes, a ticket
  that opens — belong to the NEXT run's watched set, not this one.
  Re-deriving mid-run makes a run unbounded (each re-derivation can surface
  fresh work, and the loop chases a moving queue until its budget expires)
  and makes the watermark a lie: it names a set the run never actually
  finished. Your watermark always hashes THE SNAPSHOT you opened with.
- ONE TERMINAL CHECKPOINT. Post exactly one checkpoint per run, last,
  describing that snapshot. A run that emits four checkpoints because the
  world moved underneath it has not recorded four facts; it has recorded
  one fact and three races. Downstream loops (Chronicle's wake accounting,
  Auditor's scoreboard) read the checkpoint stream as one-line-per-run;
  amplification silently corrupts every metric derived from it.
- CORRECTIONS ARE FOR FACTS, NOT FOR TIME. A second checkpoint inside one
  run is legitimate only when the first was WRONG WHEN POSTED — malformed
  line, misstated status, wrong PR number. It carries
  `supersedes=<UTC-ISO>` naming the exact timestamp of the line it
  corrects, and you prove it with
  `validate-checkpoint.mjs --posted-this-run <UTC-ISO> "<line>"`
  ($night-shift-checkpoint), which rejects a second line that does not
  declare its correction. "New information arrived" is never a correction.

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
- Failing checks on your HEAD are yours — but REQUIRED and ADVISORY are
  handled differently. Required-check failures: diagnose and fix, batching
  known fixes into one push. A failing non-required check (coverage deltas,
  third-party deploy rate limits) gets exactly ONE evidence-bearing reply
  comment on the PR — what failed, why it does not block, or the follow-up
  ticket — never silence, never retry churn. Checks failing for external
  reasons (infra outage, unrelated main breakage) → `needs-human` ticket +
  checkpoint BLOCKED; do not churn retries against an external failure.
- Repeat the reconcile after every push. The PR is stable only when, for
  one HEAD simultaneously: required checks green, every advisory failure
  acknowledged per the rule above, every thread replied AND resolved,
  working tree clean. Then checkpoint `status=READY` and hand off — the
  human, or Porter within its authority level, executes the merge. Cap of
  six fix/push cycles per run; on hitting it, checkpoint
  `status=INCOMPLETE` with the exact next action.
- `status=READY` is per-HEAD, not permanent: new review activity or a new
  HEAD reopens stewardship at your next wake. If main has moved under a
  READY PR and it no longer merges cleanly, rebase and re-run the gates —
  READY means mergeable now, not mergeable when you last looked. The
  one-PR rule already blocks new work while your PR is open; stewardship
  is what you do with that time.
- STEWARD WAKES. PR-authoring loops carry additional steward-only wakes
  between discovery wakes (the scheduled prompt says "STEWARD WAKE").
  On a steward wake you run THIS SECTION and nothing else: no discovery,
  no new PRs, no ticket sweeps — even if your watermark shows new work;
  discovery stays on your charter cadence.
  Steward wakes are FREQUENT (every 15 minutes, charters/README.md) and
  therefore must be CHEAP by default. Their first act is a deterministic
  probe, before any reasoning about the PR:
  1. No open PR of yours → exit silently. No checkpoint, no digest, no
     analysis. This is the overwhelmingly common case and it must cost
     one `gh pr list` and nothing else.
  2. Your charter's own SCHEDULE cron fired within the last
     WALL_CLOCK_BUDGET — evaluate the cron in the SCHEDULER timezone
     (charters/README.md "Timezones") → exit silently. A discovery wake
     is probably still running, and two hands on one PR is worse than a
     late reply.
     This is deliberately NOT "is my newest checkpoint recent". Run
     boundaries puts the checkpoint LAST, so a discovery wake in flight
     has posted nothing and its newest checkpoint is from the PREVIOUS
     run — days old for a weekly loop. A checkpoint-age guard passes at
     exactly the moment it needs to block, and at a 15-minute cadence
     that race stops being rare and becomes routine on every run that
     opens a PR.
  3. Nothing changed on the PR since your newest checkpoint: same head
     SHA, same check conclusions, and no review-thread activity —
     compare the MAX `updatedAt` across all review threads, never the
     thread COUNT. Count is invariant under the two commonest events: a
     reply posted inside an existing thread, and a thread being resolved.
     A count-based probe therefore exits silently on exactly the comment
     this cadence exists to answer, and it fails closed to SILENCE — the
     loop looks healthy while the comment sits unanswered. The probe
     already pays for the `reviewThreads` read; take the timestamp.
  Only when the probe reports an actual change do you spend the wake.
  A steward wake that acts checkpoints once (Run boundaries); a steward
  wake that exits on the probe never checkpoints — silent exits are not
  events and must not appear in Chronicle's wake accounting.

## Findings & tickets (Linear)

- Every finding gets a stable fingerprint: `<loop>:<subsystem>:<symbol-or-
  path>:<mechanism>`. Before filing anything, search Linear for the
  fingerprint (it appears verbatim in the ticket body). Found & open →
  update that ticket, never file a twin. Found & closed → reopen only if
  the relevant code hash changed since closure.
- Ticket labels: `night-shift`, `loop:<name>`, plus severity. Escalations
  that block you get `needs-human` and a checkpoint with status=BLOCKED.

## Blocked-state recovery

A BLOCKED checkpoint describes the PREVIOUS run's world, not this one's.
BLOCKED is never sticky: at wake, before honoring your own BLOCKED status,
re-probe the blocker — cheaply, first thing. Classes:

- ENVIRONMENTAL (tool or MCP disconnected, gh/API auth failure, rate limit,
  missing binary): re-test at EVERY wake — outages are routinely healed by
  the next run. Probe succeeds → proceed with the normal run, and comment
  the recovery evidence on the ticket you filed for the outage (close it if
  it existed solely for the outage). Never sit BLOCKED on an environmental
  cause that no longer reproduces.
- DECISION (a needs-human ruling you require): do not re-attempt the work;
  check the ticket. Still open → one-line BLOCKED checkpoint referencing
  it, no new ticket, no re-analysis. Closed or answered → the answer is
  your input; proceed accordingly.
- DEFECT (a real bug in your own collector/charter/tooling): retry only
  when the relevant code changed since the blocking run (compare the
  file hash or main SHA in your ticket's evidence); unchanged code →
  re-checkpoint BLOCKED against the same fingerprint, never a twin ticket.

Three consecutive BLOCKED checkpoints with the same cause and no state
change → raise severity on the EXISTING ticket instead of appending a
fourth identical checkpoint story; your wake budget is better spent on
the re-probe than on re-narration.

## Learnings

- `.night-shift/<name>.md` is yours. Read ALL of `.night-shift/*.md` at wake; write only
  your own. Entries are durable, codebase-specific, and consolidated —
  no run logs, no timestamps-as-content, no generic advice.
- Hard cap 120 lines per learnings file. At cap, consolidate before you
  append — merge duplicates, delete entries invalidated by code changes
  (the Librarian enforces this on its sweep). Every loop reads every
  learnings file at every wake; an unbounded file taxes the whole fleet.
- A learning lands in the same PR that established it. Loops without PR
  authority append learnings to their state issue under `## pending-learnings`;
  the Librarian loop (charters/librarian.md) verifies and migrates those into
  the tracked `.night-shift/*.md` files on its weekly sweep, marking migrated
  entries with a reply on the state issue. Between sweeps, pending entries
  living only on Linear is expected, not a bug; a human or any PR-authoring
  loop may hand-migrate a high-value entry sooner.
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

- Never merge or enable auto-merge — sole exception: Porter, executing
  strictly within charters/porter.md's committed AUTHORITY_LEVEL; no other
  loop, ever, and Porter never exceeds the level in its committed charter.
  Never deploy, migrate schemas, touch live data, weaken an
  assertion/threshold/timeout, or add a retry to make CI pass.
- One open PR per loop, ever. Resume it or close it before starting another.
- NEVER END A RUN HOLDING VALIDATED WORK. IF your charter grants PR-authoring
  authority and you have a commit whose gates passed, push your branch and
  open — or update — the PR in the SAME run. Your charter's `AUTONOMY` grant
  is your standing authorization (AGENTS.md "Working rules" carves this out
  explicitly), so there is no further approval to wait for and no one awake to
  give one. A loop whose charter grants no such authority never reaches this
  rule: it should be holding no commit at all, and if it somehow is, that is
  the finding.
  You have no memory of previous runs: an unpushed local commit is unreachable
  at your next wake, so "awaiting push approval" does not defer the work, it
  destroys it and hides that it ever existed.
  BUDGET EXPIRY DOES NOT EXCUSE IT. The phase-boundary stop below means stop
  starting NEW work; it never means abandon FINISHED work. Pushing a commit
  that already exists costs seconds. Push, open or update the PR, then
  checkpoint INCOMPLETE naming the stewardship that remains.
  If something genuinely prevents the push, that is a DEFECT-class blocker
  (Blocked-state recovery): file a fingerprinted `needs-human` ticket
  recording the commit SHA and the diff so the work survives the run, then
  checkpoint BLOCKED referencing that ticket. A bare BLOCKED line is the same
  silent loss in a different field — by your next wake the commit is gone and
  there is nothing left to re-probe.
- Branch naming: `night-shift/<name>/bst-<id>-<fingerprint-slug>` when the run
  has an owning Linear ticket; `night-shift/<name>/<fingerprint-slug>` only
  when it genuinely has none. The ticket id is the fleet's JOIN KEY. Linear
  links a PR to its issue through the branch name or a closing keyword, so a
  branch carrying neither leaves the ticket and the code permanently
  unlinked — and every downstream measure computed over that link (Sweep's
  close rule, Chronicle's digest, Auditor's scoreboard) is silently summing
  over a join that does not exist. Your PR body therefore carries
  `Closes BST-<id>`, or an explicit `No ticket: <reason>` line. Neither is
  optional; a PR with no ticket and no stated reason is incomplete.
  Already-open PRs are GRANDFATHERED on their existing branch name — never
  re-branch an in-flight PR to satisfy this, since that discards its review
  history. Add the `Closes BST-<id>` line to the body instead; the closing
  keyword links it without a rename. The branch shape binds new branches only.
- Re-derive every command, path, and enumeration from the repo at wake.
  Anything memorized in a charter or learning is a hint, not a fact.
- Labels on GitHub PRs: only the `review/*` namespace (owned by Assay) and
  never the functional `coverage` label. No workflow may ever consume a
  `review/*` label — docs/agents/ci-quality.md forbids CI routing labels.
- Budget: note UTC time at wake; check it only at phase boundaries. On
  expiry: stop subagents, append a checkpoint with exact next action, exit
  BLOCKED or INCOMPLETE. An out-of-scope-but-valuable discovery is never
  dropped — it becomes a Linear backlog ticket with evidence attached.
