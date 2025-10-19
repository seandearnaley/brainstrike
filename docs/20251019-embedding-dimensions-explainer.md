# Embedding Dimensions Explainer (2025-10-19)

This note captures our current understanding of embedding vector dimensions,
provider capabilities, and the trade-offs Brainstrike faces when expanding
search coverage beyond the local transformers bundle.

## Why This Matters
- `file_chunks.embedding` is declared as `VECTOR(768)` and the worker stack
  assumes 768-dimensional vectors. Selecting a 384D or 1024D model throws a
  pgvector dimension error during insert.
- We increasingly index code for semantic search and plan to add hosted
  providers (OpenAI, Google Gemini, Cohere). Each provider defaults to
  different dimensions and exposes controls to shrink vectors.
- We need a shared baseline so new contributors (and the UI) know which models
  are safe to use without reworking the database schema.

## Current Repository Defaults
- Local models include:
  - `jina-embeddings-v2-base-code` (768D) – default code-aware option.
  - `BAAI/bge-small/base` variants (384D) – lighter, fast inference.
  - `BAAI/bge-large-en-v1.5` (1024D) – highest local quality, exceeds schema.
- Desktop and browser flows serialize embeddings into `file_chunks.embedding`
  and rehydrate using the same assumption: `vector(768)`.
- Runtime code (worker, browser queue, repositories) logs warnings about
  mismatched sets but ultimately depends on the static column size.

## External Provider Landscape

| Provider | Model | Default dims | Notes |
|----------|-------|--------------|-------|
| OpenAI | `text-embedding-3-large` | 3072 | API supports shorter vectors via `dimensions`, e.g., 1024 or 768 while retaining strong MTEB scores.<br/>Source: [OpenAI announcement, 2024-01-25](https://openai.com/index/new-embedding-models-and-api-updates/). |
| OpenAI | `text-embedding-3-small` | 1536 | Can downscale to fit tighter budgets. |
| Google | `gemini-embedding-001` | 3072 | Recommends 768/1536/3072 and exposes `output_dimensionality`; embeddings remain high quality after truncation.<br/>Source: [Gemini API docs, 2025-10-01](https://ai.google.dev/gemini-api/docs/embeddings). |
| Cohere | `embed-v4` family | 1536 (default) | Caller may choose 256/512/1024/1536 via `output_dimension`.<br/>Source: [Cohere Embed API](https://docs.cohere.com/reference/embed). |
| BAAI | `bge-large-en-v1.5` | 1024 | Open-source baseline; requires schema update or vector downscaling. |
| Jina | `embeddings-v2-base-code` | 768 | Fits existing schema with no changes.<br/>Source: [Jina model card](https://jina.ai/models/jina-embeddings-v2-base-code/). |

Providers we care about either (a) already emit ≤768D vectors, or (b) allow us
to request a 768D variant. No roadmap item currently forces >1536 dimensions.

## Options We Evaluated
1. **Make the database column dimensionless (`VECTOR`) and juggle multiple
   indexes:** Flexible but requires updating migrations, rebuilding HNSW/IVF
   indexes, persisting per-chunk dimensions, and refactoring repositories,
   queue payloads, and UI validation. High coordination cost across packages.
2. **Standardize on a single dimension (e.g., 768D) and reject mismatches:**
   Minimal schema churn. Requires hard limits in the UI, worker, and queue so
   we never enqueue incompatible models.
3. **Support a small fixed set (e.g., 768D + 1024D) by partitioning data or
   using separate embedding sets:** Still needs schema/index changes and careful
  deduping logic. Complexity approaches option 1 without clear benefit today.

## Recommendation (as of 2025-10-19)
Stay on option 2:
- Treat 768D as the project-wide baseline.
- Configure hosted providers (OpenAI, Gemini, Cohere) to return 768D vectors
  via their dimension controls.
- Block users from selecting models that cannot meet the baseline, and surface
  clear warnings before enqueueing.

This keeps our RAG/search quality competitive—OpenAI’s 768D truncation still
outperforms the legacy 1536D ada model—while avoiding a disruptive migration.

## Next Steps for Contributors
1. **Add guardrails** in the importer/assistant UI to prevent
   non-compliant model selection and document the accepted dimension.
2. **Update worker and queue payloads** to validate the `embedding_set_id`
   against the declared dimension before persisting.
3. **Document provider-specific settings** (OpenAI `dimensions`, Gemini
   `output_dimensionality`, Cohere `output_dimension`) in setup guides.
4. **Revisit multi-dimension support** only if we adopt a provider that
   cannot downscale economically or if benchmarks show significant gains from
   higher dimensions.

Keeping these notes current will help every new contributor understand why the
database is still fixed at 768D and how to integrate additional providers
without breaking vector search.
