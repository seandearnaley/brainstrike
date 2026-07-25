---
name: night-shift-checkpoint
description: Validate a Night Shift state-issue checkpoint line against the fleet protocol grammar before posting it to Linear. Use in every loop's checkpoint step; a rejected line is never posted.
---

# Night Shift checkpoint validator

Shared executable spec of the checkpoint grammar defined in
`.night-shift/PROTOCOL.md` ("Identity & state"). Every loop runs it over the
composed checkpoint line BEFORE posting the comment on its state issue:

```bash
node .agents/skills/night-shift-checkpoint/scripts/validate-checkpoint.mjs \
  "2026-07-23T04:07:00Z | watermark=sha:<40-hex> | status=NOOP | delta empty, no open PR"
```

Exit 0 (`valid` on stdout) → post the line verbatim. Exit 1 → the reason is on
stderr; fix the line and re-validate. Never post a line the validator
rejected, and never "fix" a rejection by editing a previously posted comment —
checkpoints are append-only.

## Second line in one run

A run posts ONE checkpoint (PROTOCOL.md "Run boundaries"). If this run has
already posted one and you believe a second is warranted, you must say so:

```bash
node .agents/skills/night-shift-checkpoint/scripts/validate-checkpoint.mjs \
  --posted-this-run 2026-07-25T04:17:48Z \
  "2026-07-25T04:21:27Z | watermark=none | status=PR | supersedes=2026-07-25T04:17:48Z status was misstated as NOOP"
```

With `--posted-this-run`, a line that lacks `supersedes=<that exact
timestamp>` is rejected. This is deliberate: the only legitimate second line
is a correction of a line that was WRONG WHEN POSTED. A PR head that moved, a
run that finished, or a ticket that opened while you worked is the NEXT run's
watched set — re-grading it now produces a checkpoint stream that Chronicle's
wake accounting and Auditor's scoreboard both read as extra runs.

## Grammar

`<UTC-ISO> | watermark=<kind>:<value> | status=<STATUS> | <one line>`

- Timestamp: second-precision UTC ISO ending in `Z` (no milliseconds, no
  offsets), and a real calendar instant.
- Watermark kinds: `sha:<40-hex>` (MAIN-DIFF loops — last main SHA fully
  swept), `hash:<64-hex>` (EXTERNAL-STATE loops — sha256 of the sorted,
  serialized watched set), or `none` (first run only). Bare untyped values
  are rejected.
- Status: `NOOP | PR | READY | INCOMPLETE | BLOCKED`.
- Message: non-empty, one line, max 300 characters. Pipes inside the message
  are allowed.
- Optional `supersedes=<UTC-ISO>` token in the message: at most one, a real
  second-precision UTC instant, strictly earlier than the line's own
  timestamp. Required when `--posted-this-run` is passed.

Checkpoints posted before this grammar existed parse as legacy — Chronicle
exempts them; never rewrite them.

The validator is read-only with respect to the repo and Linear: it inspects
its single argument and exits. It never posts, edits, or deletes anything.
