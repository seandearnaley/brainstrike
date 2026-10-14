# Zero-match glob steering — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "A ZERO-MATCH GLOB STEERS TO `includeIgnored` — BUT ONLY WHEN THAT WOULD HELP".
Read before changing the excluded-path hint or its matching rules.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '763,792p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

### A ZERO-MATCH GLOB STEERS TO `includeIgnored` — BUT ONLY WHEN THAT WOULD HELP

Widening the exclusion set from a fixed denylist to "whatever the repo ignores"
means `globWorkspace({pattern: 'coverage/**'})` returns a bare `{count: 0}`,
indistinguishable from "those files do not exist" — a NEW instance of the silent
failure this walk exists to remove. The walk reports what it excluded
(`onExcluded`) and the tool emits a `hint` naming `includeIgnored`.

Three rules, each load-bearing, each with a test:

- **PARTIAL matching for a pruned DIRECTORY, FULL matching for a FILE.** A
  pruned directory is reported instead of its contents, so it is only a prefix
  and `coverage` must partial-match `coverage/**`. A file is the whole path.
  Using partial for both makes the steer fire whenever ANY file was excluded,
  because bare patterns are made recursive (`secrets/**` → `**/secrets/**`) and
  under a leading `**` nearly every path partial-matches. That is why
  `onExcluded` carries `isDirectory`.
- **Never for the HARD agent layers**, via `matcher.ignoresHard`. The advice
  would be a dead end (`includeIgnored` cannot lift them), and reporting the
  path would DISCLOSE that something exists where the user asked for nothing to
  be visible — most of what `.llmignore` was bought for. `.git` is excluded from
  reporting for the dead-end half of the same reason.
- **Never when the caller already passed `includeIgnored`, or when
  `scanLimited`** — the latter's honest answer is "the walk did not finish",
  which its own note already gives.

The pre-existing "nothing matches" case (`**/*.rs`) still asserts `hint` is
undefined. Keeping it unamended is the evidence that the steer is precise rather
than firing on every empty result — a hint on every call is noise the model
learns to skip, which costs the one case that needed it.
