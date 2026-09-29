# The srt pin and the bump procedure — evidence

Supports `docs/agents/code-execution.md` § "FenceExecutor". Read this before
bumping `@anthropic-ai/sandbox-runtime`. The contract holds the rules; this
file is the record of why, including which CI row actually runs the Linux half.

Corrected at extraction (verified against `.github/workflows/test.yml`): the
escape-resistance suite no longer lands in `Unit (rest)`. The `rest` shard
filters `@brainstrike/agent` out, and `packages/agent` owns the dedicated
`agent-1` / `agent-2` native Vitest shards — so the suite runs in one of the
`Unit (agent-N)` rows. The rest of the bullet (open the affected-integration
step and confirm the file RAN rather than printing `SUITE SKIPPED`) is
unchanged.

- **srt version: `@anthropic-ai/sandbox-runtime` pinned EXACTLY to `0.0.75`**
  (bumped from `0.0.67` in BST-1285, then from `0.0.73` in BST-1669) in the
  workspace catalog (`catalogMode: strict` means every package references the
  catalog; the catalog entry itself carries no caret). It is a fast-moving beta
  — re-derive the boundary from its README/`.d.ts` before bumping, never from
  memory, and diff the published tarballs rather than reading the new one alone.
  The escape-resistance suite (BST-1071) ASSERTS this version, so a bump goes
  red until the suite is re-greened on macOS AND Linux; see
  `packages/agent/src/__tests__/fence-escape-resistance.README.md` for the
  required procedure and the guarantee/non-guarantee list. **CI supplies the
  Linux half as of BST-1316**: the `unit-shard` job installs
  `bwrap`/`socat`/ripgrep and clears
  `kernel.apparmor_restrict_unprivileged_userns`. Note the lane naming, because
  it is easy to look in the wrong place: this is an `*.integration.spec.ts`
  suite, but the job that runs it is the one whose check reads **`Unit
  (<shard>)`** — that job runs `test` AND `test:integration`, and the
  escape-resistance file lands in **`Unit (rest)`**, under the step *Pull
  request affected integration tests*. A green `Unit` is not evidence on its
  own: open that step and confirm the suite RAN rather than emitting
  `describeHostSkipReason()` — the file line should read `✓
  fence-escape-resistance.integration.spec.ts (32 tests)` with no
  `SUITE SKIPPED`. Note also that a CI runner has no credential stores, so the
  `~/.ssh` containment cases prove only "refused" there and get their
  full-strength form from the macOS half. **CI supplies no macOS half at all**
  (no macOS runner), so that one is always a local run, and the bump log has to
  say which platforms actually ran rather than which were assumed.
