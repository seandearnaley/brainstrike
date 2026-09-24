# Gutter-prefix write guard — evidence

Supports `docs/agents/assistant-runtime.md` § "GUTTER-PREFIX WRITE GUARD (BST-1202)".
Read before broadening or relaxing the gutter-paste heuristic. BST-1202, PR #2352.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2915-2964), extracted verbatim.

`readWorkspaceFile` renders model-visible pages in
`read-workspace-file-tool.ts` (`renderReadWorkspaceFilePage`) with an unpadded
`${line}: ` prefix. `gutter-prefix-guard.ts` conservatively identifies that
display form before it can be pasted back onto disk. Refusal requires ALL of:
at least three lines matching the exact `^\d+: ` shape; those captured numbers
forming a monotonic NON-DECREASING run (an exact adjacent repeat is tolerated,
a decrease is not) with a TIGHT SPAN (`max - min < 2 * count`); and the run's
first (smallest) number being greater than 1. Do not broaden the prefix shape.

The tight-span bound (not a strict `+1` requirement, and not a majority-of-
lines proportion — PR #2352 review replaced the original design that used
both) is what does the actual discriminating work: it tolerates a single
deleted line from an edited paste (`10,11,13,14,15`, span 5 over 5 matches)
and a repeated boundary number — `renderReadWorkspaceFilePage` re-emits the
SAME line number as the prefix on both halves of a line split across a page
boundary, so a verbatim paste of two continuation pages repeats it — while
still rejecting two unrelated reads pasted back to back (`40,41,100,101`,
span 61 over 4 matches) and non-sequential content that merely starts with
digits (`12,45,90`).

**Known coverage boundary — deliberate, not an oversight.** A page-1 paste
(gutter numbers starting at 1, e.g. a verbatim `1: a\n2: b\n3: c`) is NEVER
refused. Legitimate sequential numeric-key content — a YAML mapping
(`1: January\n2: February\n3: March`), a numbered config list, any 1-based
enumeration — is textually IDENTICAL to a page-1 gutter paste (the common
case, since `readWorkspaceFile` defaults to starting at line 1); no signal in
the text distinguishes them. Blocking the legitimate write is strictly worse
than missing this one paste shape: a false refusal makes an ordinary numbered
write permanently impossible through these tools, while a missed page-1 paste
still gets caught by the model's own read-verify cycle after the corrupted
write lands. Only a read that started past line 1 (an explicit `startLine`,
or a continuation cursor) produces gutter numbers starting above 1, so only
THOSE pastes are guarded. Do not relax the `first > 1` requirement to close
this gap — it would reopen the YAML/numbered-mapping false positive instead.

The guard applies only to `writeWorkspaceFile.content` and
`stringReplaceWorkspaceFile.newStr`. It deliberately does not inspect
`stringReplaceWorkspaceFile.oldStr` (quoted from real file content), and delete
and rename have no content argument. In `runWriteWorkspaceFile` the
`MAX_WRITE_WORKSPACE_FILE_BYTES` size check runs BEFORE the guard (both are
pure pre-lock validations) so an over-limit payload is rejected before it
pays for the guard's `split('\n')` pass. This is a fourth, independent,
STATELESS mechanism: it has no thread scope or Map and does not participate
in `MAX_KEYS_PER_THREAD_SCOPE`/`MAX_TRACKED_THREAD_SCOPES`. A match throws
`ToolInputError` before locks, disk I/O, or the "Repeated string-replace
failures" path above can reach `recordEditFailure`; a gutter refusal consumes
zero edit-failure streak slots. An out-of-safe-integer captured number (e.g.
an attacker appending `99999999999999999999: x` to an otherwise perfect
gutter block) disqualifies only that ONE line — it is skipped, not treated as
a reason to abort the whole check, so it cannot be used to defeat the guard.
