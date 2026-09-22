# Model enablement defaults — evidence

Supports `docs/agents/assistant-providers.md` § "`is_enabled` is not evidence of
user intent". BST-1794: the seven catalog models that became permanently
unreachable, why a per-provider hook could not have fixed it, the `all`/`seed`
policy split, and the migration audit behind the `updated_at` invariant.

---

## The bug (BST-1794)

- Catalog models mirror into the PGlite `models` table shipping
  `is_enabled = false`. `initializeProviderModelDefaults` is the only code that
  enables a row without the user.
- Before the fix, its only gate was `hasExplicitProviderModelChoice`: a
  PROVIDER-WIDE `Boolean(row.is_enabled) || updatedAt > createdAt`, OR'd across
  every row belonging to that provider. The moment ANY row in a provider was
  enabled — including a row the CATALOG shipped enabled, not the user — the OR
  went permanently true and `initializeProviderModelDefaults` returned
  `'preserved'` for every OTHER row that provider would ever add. A
  shipped-enabled row was read as user intent, which it never was.
- Seven catalog models were consequently unreachable in the chat model picker:

  | Model | id | Migration |
  | --- | --- | --- |
  | Claude Opus 5 | `claude-opus-5` | 116 |
  | Claude Fable 5.1 | `claude-fable-5-1` | 122 |
  | GPT-6 Astra | `gpt-6-astra` | 123 |
  | Gemini 3.8 Flash | `gemini-3.8-flash` | 124 |
  | Gemini 3.7 Flash | `gemini-3.7-flash` | 104 |
  | Gemini 3.6 Flash | `gemini-3.6-flash` | 124 |
  | Gemini 3.5 Flash-Lite | `gemini-3.5-flash-lite` | 124 |

  All seven ride an existing, already-enabled row in their provider
  (`claude-sonnet-5` for anthropic, `gemini-2.5-flash` for google, etc.), so the
  provider-wide OR was already latched true before any of these migrations ran.

## Why a per-provider hook would have been a no-op

- The three now-deleted hooks (`use-openrouter-model-defaults.ts`,
  `use-bedrock-model-defaults.ts`, `use-openai-codex-model-defaults.ts`) each
  called the SAME shared store action, `initializeProviderModelDefaults`, with a
  fixed `modelIds` list. They differ only in which provider they target, never in
  how the action decides "has this provider already been chosen."
- A hypothetical fourth hook for anthropic/google/openai, built the same way,
  would have called into the identical `hasExplicitProviderModelChoice` gate and
  inherited the identical short-circuit. The defect was never "the wrong hook
  runs for this provider" — it was the SHARED predicate's granularity: provider,
  not row. Adding hooks cannot fix a bug that lives one layer below every hook.
- The fix therefore replaced the granularity, not the hook topology: the `all`
  policy path in `initializeProviderModelDefaults` (`packages/app-state/src/
  stores/model-registry-store.ts`) now computes its target ids by filtering the
  provider's own rows through `isLlmChoiceRow` and the new `isUntouchedChoiceRow`
  (per row, not per provider), and the three per-provider hooks collapse into one
  composed `useProviderModelDefaults` driven by `PROVIDER_MODEL_DEFAULT_POLICIES`.

## The `all` / `seed` split, and the OpenRouter opt-in consequence

- `{ kind: 'all' }` (anthropic, google, openai) is STANDING: re-evaluated every
  app session against the live row set, so a model a LATER migration adds becomes
  reachable with no further code change. This is the exact property the bug
  broke and the fix restores.
- `{ kind: 'seed', modelIds }` (bedrock, openai-codex, openrouter) is a STARTER
  KIT: a curated list applied ONCE, gated by the ORIGINAL provider-wide
  `hasExplicitProviderModelChoice` check (unchanged behaviour on that path).
  Re-applying a curated subset over a profile the user has already curated would
  be presumptuous, so `seed` deliberately keeps the coarser, provider-wide gate.
- Consequence recorded deliberately, not residue to "fix" later: an OpenRouter
  route added after the seed (e.g. `deepseek/deepseek-v4.1-flash`) stays opt-in
  forever. Widening OpenRouter to `{ kind: 'all' }` is a separate, deliberate
  decision to accept every future OpenRouter catalog addition automatically —
  do not fold it into a routine catalog-addition change.
- `null` (cohere, voyage: embedding-only; local, ollama, lmstudio: keyless) means
  no catalog defaults at all. The `null`-iff rule — `authType === 'none' ||
  !capabilities.llm` — is pinned against the LIVE catalog by
  `provider-model-default-policies.test.ts` rather than hand-maintained as a
  list, so a new provider cannot silently land with the wrong policy shape.

## The `updated_at > created_at` invariant, and its live hazard

The `all` policy's per-row test, `isUntouchedChoiceRow`, rests on one invariant:
catalog upserts never write `models.updated_at`, so `updated_at > created_at` is
a clean per-row record of a user toggle. Verified against every migration that
writes `models.updated_at` or `providers.updated_at`:

- Migrations 020, 024 and 028 DO write `models.updated_at`, but every row they
  touch belongs to the `local` provider (`onnx-community/
  functiongemma-270m-it-ONNX`, `LiquidAI/LFM2.5-1.2B-Instruct-ONNX`,
  `onnx-community/Qwen3-0.6B-ONNX`, `onnx-community/gemma-4-E2B-it-ONNX`).
- Migration 023 writes `providers.updated_at`, not `models`. Migrations 051 and
  067 create/touch unrelated tables (`prompt_items`, the thread search index),
  never `models`.
- `local` carries a `null` policy today, so no provider with an `all` policy is
  affected by any of the above.
- The hazard is LIVE for the future, not closed by this fix: giving `local` an
  `all` policy, or a future migration that bumps `models.updated_at` for an
  existing `all`-policy provider's row (anthropic, google, openai), would
  silently mark that row "touched" forever and make it permanently unreachable
  by the availability policy — reproducing this exact bug class through a
  different provider. The next person adding a migration that upserts `models`
  needs to know this before reaching for `updated_at = NOW()` out of habit.
- Design note: the mechanism is self-marking. The enabling `UPDATE` in
  `model-registry-store.ts` sets `updated_at = NOW()` on the row it turns on, so
  a row this code enables becomes a permanent "user touch" record — a later user
  decision to disable it is never re-overridden by a subsequent default pass.
  This is intentional: `isUntouchedChoiceRow` requires `!is_enabled` as its first
  conjunct precisely so no default policy can ever switch a model off. But it
  means the ENABLING side effect and the "was this a real user choice" signal
  share one column; a future feature needing to distinguish "system-enabled" from
  "user-enabled" cannot reuse `updated_at` for that distinction.
