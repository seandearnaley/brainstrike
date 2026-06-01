# Frontier Model Refresh (May 2026)

**Branch:** `feat/update-frontier-models-2026-05`
**Date:** 2026-05-28
**Author:** Sean + Claude (pair)

## Goal

Update the supported AI chat models for OpenAI, Anthropic, and Google to the latest
frontier IDs (verified against live provider docs on 2026-05-28), expose a *generous*
curated selection per provider so users have variety, set sensible *cost-aware* defaults,
add Google's new `gemini-embedding-2`, and patch-bump the AI SDK provider packages.

No re-architecture is warranted: the registry (`packages/assistant-contract/src/provider-registry.ts`)
is already a clean single source of truth that everything downstream derives from. The
change is **data + migrations + tests + a dependency patch bump.**

## Verified model IDs (live docs, 2026-05-28)

| Provider | Source | Confirmed |
|---|---|---|
| Anthropic | platform.claude.com/docs models overview | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` (Haiku 4.5 is still latest; **no 4.6**). Legacy still live: `claude-opus-4-7/4-6`, `claude-sonnet-4-5`, `claude-opus-4-5`. |
| OpenAI | developers.openai.com/api/docs/models/all | `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex`, `gpt-5.2`, `gpt-5.2-pro`. Embeddings unchanged: `text-embedding-3-small/large`. |
| Google | ai.google.dev/gemini-api/docs/models + embeddings | `gemini-3.5-flash` (stable), `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite` (stable), `gemini-2.5-pro/flash/flash-lite` (stable), `gemini-embedding-2` (3072 default, 128–3072 via `output_dimensionality`, auto-normalizes), `gemini-embedding-001`. |
| OpenRouter | openrouter.ai/api/v1/models (dotted slugs) | `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-5.3-codex`, `openai/gpt-5.2`, `anthropic/claude-opus-4.8`, `anthropic/claude-sonnet-4.6`, `anthropic/claude-haiku-4.5`, `google/gemini-3.5-flash`, `google/gemini-3.1-pro-preview`, `google/gemini-2.5-flash`. |

## Target registry (LLM)

**OpenAI** (default `gpt-5.4`): `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`★, `gpt-5.4-pro`,
`gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex`, `gpt-5.2`, `gpt-5.2-pro`.
Drop `gpt-5.2-chat-latest` (docs: "not recommended for API use").

**Anthropic** (default `claude-sonnet-4-6`): `claude-opus-4-8`, `claude-sonnet-4-6`★,
`claude-haiku-4-5`. Drop `claude-sonnet-4-5`, `claude-opus-4-5`.

**Google** (default `gemini-3.5-flash`): `gemini-3.5-flash`★, `gemini-3.1-pro-preview`,
`gemini-3.1-flash-lite`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`.
Drop `gemini-3-flash-preview`, `gemini-3-pro-preview`.

**OpenRouter** (default `openai/gpt-5.4`): `openai/gpt-5.5`, `openai/gpt-5.4`★,
`openai/gpt-5.4-mini`, `openai/gpt-5.3-codex`, `openai/gpt-5.2`,
`anthropic/claude-opus-4.8`, `anthropic/claude-sonnet-4.6`, `anthropic/claude-haiku-4.5`,
`google/gemini-3.5-flash`, `google/gemini-3.1-pro-preview`, `google/gemini-2.5-flash`.

## Target registry (embeddings)

- OpenAI: unchanged (`text-embedding-3-small`★, `text-embedding-3-large`).
- Google: keep `gemini-embedding-001`★ as default (avoids re-embedding existing vector
  stores); **add** `gemini-embedding-2` (defaultDimension 3072, supportsCustomDimensions,
  `output_dimensionality`, supportsStandardDimension true).
- Cohere/Voyage: unchanged.

## Migrations (`assistant-preferences-store.ts`)

Bump `ASSISTANT_PREFERENCES_STORE_VERSION` 5 → 6. Update `MODEL_ID_MIGRATIONS` so users
pinned to removed IDs land on a valid model:

- **openai**: retarget legacy `gpt-4o*`/`gpt-4-turbo`/`gpt-3.5-turbo` to `gpt-5.4`/`gpt-5.4-mini`; add `gpt-5.2-chat-latest → gpt-5.4`.
- **anthropic**: add `claude-sonnet-4-5 → claude-sonnet-4-6`, `claude-opus-4-5 → claude-opus-4-8`; retarget dated/`-latest` legacy entries to 4-6/4-8 (Haiku stays `claude-haiku-4-5`).
- **google**: add `gemini-3-flash-preview → gemini-3.5-flash`, `gemini-3-pro-preview → gemini-3.1-pro-preview`; **remove** `gemini-2.5-flash`/`gemini-2.5-pro` migration entries (now first-class models); retarget `gemini-1.5/2.0-pro → gemini-2.5-pro`.
- **openrouter**: add `google/gemini-3-flash-preview → google/gemini-3.5-flash`, `anthropic/claude-sonnet-4.5 → anthropic/claude-sonnet-4.6`; remove `google/gemini-2.5-*` entries (now first-class).

## AI SDK bump

`@ai-sdk/openai` 3.0.53→3.0.66, `@ai-sdk/anthropic` 3.0.71→3.0.81,
`@ai-sdk/google` 3.0.64→3.0.80, `@ai-sdk/provider` 3.0.8→3.0.10. All same major (AI SDK
v6); factory passes model IDs as plain strings, so this is low-risk polish.

## TDD plan (red → green per phase)

1. **Registry tests** — assert new IDs present, dropped IDs absent, correct defaults
   (`resolveDefaultModel`), `gemini-embedding-2` shape. Write/extend first (red), edit
   registry (green).
2. **Migration tests** — in `assistant-preferences-store.test.ts`: persisted old ID →
   migrated new ID; store version 6; first-class `gemini-2.5-*` not rewritten. Red, then
   update store (green).
3. **Sweep dependent tests** — ~35 test files reference model-ID literals. Update the ones
   that assert removed/renamed IDs (mostly preferences + db-explorer model lists). Most
   embedding tests are unaffected (OpenAI embeddings + `gemini-embedding-001` default
   unchanged).
4. **Full suite green** — lint, typecheck, build, unit/integration all green in one run.

## Manual verification (Chrome DevTools, desktop)

- Launch desktop (`dev:agent-debug`), open the model picker, confirm new lists render and
  cost-aware defaults are pre-selected.
- For OpenAI / Anthropic / Google (with keys present): run a multi-turn conversation,
  confirm streaming, **memory** (recall across turns), and **tool** calls work.
- Confirm no console errors and no invalid-model API failures.

## Out of scope / follow-ups

- Per-model provider-option tuning (Opus 4.8 `effort` defaults to `high`, adaptive vs
  extended thinking; Google thinking levels for 3.5). Note only.
- Making `gemini-embedding-2` the embedding default (would force re-embedding; deferred).
