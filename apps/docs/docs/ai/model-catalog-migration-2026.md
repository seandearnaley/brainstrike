---
title: 2026 Model Catalog Migration
sidebar_position: 5
---

# 2026 Model Catalog Migration

BrainStrike's hosted model catalog has been upgraded to the latest provider lineups:

- **OpenAI**: `gpt-5.2` family
- **Anthropic**: `claude-*-4-5` aliases
- **Google**: `gemini-3-*-preview` (chat) + `gemini-embedding-001` (embeddings)
- **OpenRouter**: provider-prefixed slugs (e.g. `openai/gpt-5.2`)

## What This Means

- **Stored preferences**: Existing model IDs are automatically migrated on first load.
- **Custom integrations**: Any hard-coded model IDs must be updated to the new names.
- **Fail-fast behavior**: The app will surface API errors if a provider rejects an ID; no silent fallback.

## Embeddings Upgrade

`text-embedding-004` has been removed from the hosted catalog. If you used it:

1. Create a new Search Collection using `gemini-embedding-001`.
2. Backfill your content into the new collection.
3. Retire the old collection once backfill completes.

Do not mix embeddings from different models in the same collection.

## OpenRouter Notes

OpenRouter models use provider-prefixed slugs. Example:

- `openai/gpt-5.2`
- `anthropic/claude-sonnet-4.5`
- `google/gemini-3-flash-preview`
