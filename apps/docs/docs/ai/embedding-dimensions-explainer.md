---
title: Embedding Dimensions Explainer
sidebar_position: 4
---

# Embedding Dimensions Explainer (2025-10-19)

This note captures our current understanding of embedding vector dimensions,
provider capabilities, and the trade-offs Brainstrike faces when expanding
search coverage beyond the local transformers bundle.

## Why This Matters
- Hosted providers (OpenAI, Google Gemini, Cohere, Voyage) expose multiple
  embedding dimensions. Local transformers models span 384 → 1536+.
- We need pgvector to accept those embeddings without schema churn while still
  protecting similarity search from mismatched dimensions.
- UI and queue layers must surface accurate dimension metadata so contributors
  can choose compatible models and diagnose problems quickly.

## Repository Defaults (Updated 2025-10-21)
- Local models include (HuggingFace IDs):
  - `jinaai/jina-embeddings-v2-base-code` (768D) – default code-aware option.
  - `Xenova/all-MiniLM-L6-v2` (384D) – fastest general English.
  - `Xenova/bge-small-en-v1.5` (384D) – lighter, fast inference.
  - `Xenova/bge-base-en-v1.5` (768D) – higher quality English.
  - `Xenova/bge-large-en-v1.5` (1024D) – highest local quality, exceeds legacy 768D baseline.
- `file_chunks.embedding` is now declared as the dimensionless `VECTOR` type.
  pgvector no longer rejects inserts when the dimension differs from 768.
- `embedding_sets` records the canonical dimension per model/set. Repository
  writes validate embeddings against that metadata before persisting.
- Queue payloads carry `targetDimension`. The worker resolves the dimension
  from the associated embedding set and rejects only when the generated vector
  doesn't match that runtime expectation.
- Search queries require an `embeddingSetId` and verify that the query vector
  matches the set’s recorded dimension before issuing pgvector operators.

## External Provider Landscape

| Provider | Model | Default dims | Notes |
|----------|-------|--------------|-------|
| OpenAI | `text-embedding-3-large` | 3072 | API supports shorter vectors via `dimensions`, e.g., 1024 or 768 while retaining strong MTEB scores.<br/>Source: [OpenAI announcement, 2024-01-25](https://openai.com/index/new-embedding-models-and-api-updates/). |
| OpenAI | `text-embedding-3-small` | 1536 | Can downscale to fit tighter budgets. |
| Google | `gemini-embedding-001` | 3072 | Recommends 768/1536/3072 and exposes `output_dimensionality`; embeddings remain high quality after truncation.<br/>Source: [Gemini API docs, 2025-10-01](https://ai.google.dev/gemini-api/docs/embeddings). |
| Cohere | `embed-v4` family | 1536 (default) | Caller may choose 256/512/1024/1536 via `output_dimension`.<br/>Source: [Cohere Embed API](https://docs.cohere.com/reference/embed). |
| BAAI (Transformers.js) | `Xenova/bge-large-en-v1.5` | 1024 | Open-source baseline; local mirror of BAAI model; exceeds legacy 768D baseline without flexible dims. |
| Jina (Transformers.js) | `jinaai/jina-embeddings-v2-base-code` | 768 | Fits existing schema with no changes.<br/>Source: [Jina model card](https://jina.ai/models/jina-embeddings-v2-base-code/). |

Providers we care about either (a) already emit ≤768D vectors, or (b) allow us
to request a 768D variant. Voyage and Gemini can exceed 1536D, which we now
support by pairing embeddings with the correct `embedding_set` entry.

## Options We Evaluated
1. **Dimensionless column + per-set metadata.** Requires schema migration,
   repository validation, queue updates, and worker changes, but unlocks full
   multi-provider support without downsampling.
2. **Single enforced dimension (historical approach).** Minimal migrations,
   but forced us to downscale hosted models and blocked new providers.
3. **Fixed set of dimensions.** Similar complexity to option 1 with less
   flexibility; we would still need set-level metadata and complex routing.

## Decision (2025-10-21)
We adopted option 1. The migration to `VECTOR` (no length) landed in
`010-flexible-embedding-dimensions`. The runtime now:
- Creates or reuses `embedding_sets` keyed by `{model_key, dimensions, distance}`.
- Validates chunk writes and updates against the set dimension.
- Enqueues `expectedDimension` metadata so workers (Node/browser) can detect
  genuine mismatches instead of enforcing a hard-coded 768D baseline.
- Requires callers of SQL search helpers to pass an `embeddingSetId`; the
  repository checks query vector length before executing pgvector operators.

This keeps pgvector indexes intact, enables future high-dimensional providers,
and still protects us from accidental vector mixing.

## Next Steps for Contributors
1. **Surface dimension metadata in the UI.** Highlight the active embedding
   set, its dimension, and warn when a selected model produces a different size.
2. **Ensure queue payloads include `embeddingSetId`.** Desktop/web importers
   should resolve or create embedding sets up front so workers can validate.
3. **Document provider-specific settings** (OpenAI `dimensions`, Gemini
   `output_dimensionality`, Cohere `output_dimension`) in setup guides.
4. **Benchmark higher dimensions.** With schema barriers removed we can
   experiment with 1024D+ providers and decide whether to store multiple sets
   per project.

Keeping these notes current will help new contributors understand how the new
embedding-set metadata keeps pgvector safe while unlocking richer model
catalogues.
