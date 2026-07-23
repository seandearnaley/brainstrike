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

Checkpoints posted before this grammar existed parse as legacy — Chronicle
exempts them; never rewrite them.

The validator is read-only with respect to the repo and Linear: it inspects
its single argument and exits. It never posts, edits, or deletes anything.
