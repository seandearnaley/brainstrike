# The current-date note — evidence

Supports `docs/agents/assistant-runtime.md` § "SYSTEM-INSTRUCTION COMPOSITION".
Read before moving `buildCurrentDateNote`, changing its format, or threading a clock into the instruction builders.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 4158-4186), extracted verbatim.

**THE DATE IS COMPOSED OUTSIDE THE PROVIDER BRANCH — do not relitigate.**
`buildCurrentDateNote` is joined into `stableText` alongside the budget note,
NOT threaded into `buildDefaultInstructions`. There are three supported
instruction paths — the hosted default, `buildLocalDefaultInstructions` for the
built-in local model, and a caller-supplied `instructions` override — and only
the first takes options. Injecting there left the other two shipping dateless
prompts; the local one arguably needs it most, since a small local model is the
least able to recover from not knowing the date.

Nothing in the prompt used to state the day. A model with no date does not
abstain — it substitutes its training cutoff or a guess. An observed run
reasoned "Today's date is unknown but likely later" and then wrote a fabricated
date, three days off, into DURABLE working memory. It is also load-bearing for
an instruction AGENTS.md already gives (treat dated material under
`docs/superpowers/` and `docs/archive/` as historical evidence), which is
unfollowable without a date to compare against.

**DATE ONLY, and LOCAL.** A clock time would invalidate the cached prefix on
every turn; a date moves at most once a day. And the day is the user's, not
UTC: Brainstrike is local-first, so the process clock IS the user's clock, and
`toISOString()` would state tomorrow's date to anyone east of UTC in their early
morning. The format is `en-CA` (whose short date IS ISO 8601) plus the weekday
name — `03/04/2026` denotes two different days depending on the reader.

The clock is INJECTED (`composeRuntimeInstructions({ now })`) so the composed
instructions stay a pure function of their inputs. The paired guard drives
`createMastraAgentRuntime` with frozen time and asserts the date reaches
`config.instructions`; asserting `buildCurrentDateNote` directly would prove
only that it renders a date it was handed.
