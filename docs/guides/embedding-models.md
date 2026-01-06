# Embedding Models Guide

This guide helps you choose and configure embedding models in BrainStrike. It covers both local models (running in-browser or on-device) and hosted API providers.

## Quick Start

**Default Model**: `jinaai/jina-embeddings-v2-base-code` (768 dimensions)
- Code-aware embeddings supporting 30+ programming languages
- 8k token context window
- Runs locally (~300MB download)
- Best for code search and general development tasks

## Understanding Embedding Dimensions

Embedding dimensions determine the size of the vector representation for each text chunk. Different dimensions offer trade-offs:

- **384D**: Fast, lightweight, suitable for general text search
- **768D**: Balanced performance and quality (our default)
- **1024D+**: Higher quality but larger storage and slower search

**Important**: All embeddings in a Search Collection must use the same dimension. BrainStrike tracks this automatically via `embedding_sets`.

## Available Models

Model availability is driven by the DB-backed registry (`providers` + `models` tables) and the fallback registry in `@brainstrike/embeddings`. Enable/disable models in Settings → Embeddings; the Collections dialog uses those enabled models when creating embedding sets.

### Local Models

Local models run entirely in your browser or desktop app using WebAssembly. No API keys or internet connection required after initial download.

#### Jina AI Models

**jinaai/jina-embeddings-v2-base-code** (Default) ⭐
- **Dimensions**: 768
- **Size**: ~300MB
- **Context**: 8,192 tokens
- **Best for**: Code search, multi-language development
- **Languages**: 30+ programming languages

**jinaai/jina-embeddings-v3** (Experimental)
- **Dimensions**: 1024 (model-dependent)
- **Size**: ~570MB
- **Context**: 8,192 tokens
- **Best for**: Multilingual text, task-specific embeddings
- **Languages**: 89 languages

#### BGE (BAAI General Embedding) Models

**Xenova/bge-small-en-v1.5**
- **Dimensions**: 384
- **Size**: ~67MB
- **Context**: 512 tokens
- **Best for**: Fast English text search, resource-constrained environments

**Xenova/bge-base-en-v1.5**
- **Dimensions**: 768
- **Size**: ~130MB
- **Context**: 512 tokens
- **Best for**: High-quality English embeddings, balanced performance

**Xenova/bge-large-en-v1.5**
- **Dimensions**: 1024
- **Size**: ~330MB
- **Context**: 512 tokens
- **Best for**: State-of-the-art English text quality

#### MiniLM Models

**Xenova/all-MiniLM-L6-v2**
- **Dimensions**: 384
- **Size**: ~23MB (smallest!)
- **Context**: 512 tokens
- **Best for**: Ultra-fast search, minimal storage, English text

### Hosted Models (API Required)

Hosted providers are represented in the registry and provider factory. The embedding worker currently supports **OpenAI** and **Google**. Cohere and Voyage providers exist but are not wired into the worker yet.

Hosted models require API keys and internet connectivity but offer cutting-edge performance.

#### OpenAI

**text-embedding-3-small**
- **Dimensions**: 1536 (override via `dimensions`)
- **Best for**: Cost-effective hosted solution

**text-embedding-3-large**
- **Dimensions**: 3072 (override via `dimensions`)
- **Best for**: Best-in-class performance for production applications

#### Google

**text-embedding-004**
- **Dimensions**: 768 (override via `outputDimensionality`)

**gemini-embedding-001**
- **Dimensions**: 3072 (override via `outputDimensionality`)

#### Voyage AI

**voyage-3** (Not wired in worker yet)
- **Dimensions**: 1024
- **Best for**: Long-context multilingual retrieval

**voyage-3-lite** (Not wired in worker yet)
- **Dimensions**: 512
- **Best for**: Budget-conscious long-context applications

#### Cohere

**embed-english-v3.0** (Not wired in worker yet)
- **Dimensions**: 1024
- **Best for**: English-optimized with input_type support

**embed-multilingual-v3.0** (Not wired in worker yet)
- **Dimensions**: 1024
- **Best for**: Cross-lingual search (100+ languages)

## Choosing a Model

### For Code Search
- **Primary**: `jinaai/jina-embeddings-v2-base-code` (default, code-aware)
- **Alternative**: `Xenova/bge-base-en-v1.5` (English codebases)

### For General Text
- **Fastest**: `Xenova/all-MiniLM-L6-v2` (384D, 23MB)
- **Balanced**: `Xenova/bge-base-en-v1.5` (768D, quality/speed)
- **Best Quality**: `Xenova/bge-large-en-v1.5` (1024D, SOTA)

### For Multilingual Content
- **Local**: `jinaai/jina-embeddings-v3` (89 languages, experimental)
- **Hosted**: `gemini-embedding-001` (requires downscaling to <= 2000) or `cohere embed-multilingual-v3.0` (not wired yet)

### For Production/Hosted
- **Cost-effective**: OpenAI `text-embedding-3-small`
- **Best performance**: OpenAI `text-embedding-3-large` or Google `gemini-embedding-001` (downscale dimensions to <= 2000)
- **Long context**: Voyage `voyage-3` (not wired yet)

## Flexible Dimensions

BrainStrike stores vectors in a dimensionless `VECTOR` column and validates against `embedding_sets.dimensions`. The worker enforces a max dimension of **2000** (`MAX_EMBEDDING_DIMENSION`), so hosted models with larger defaults must be downscaled in the embedding set configuration.

Supported dimension overrides today:
- **OpenAI**: `dimensions` parameter (from embedding set)
- **Google**: `outputDimensionality` parameter (from embedding set)

**Note**: The Collections dialog currently uses the model registry's default dimensions and does not expose per-collection overrides yet.

## Technical Details

### Database Schema
BrainStrike uses a dimensionless `VECTOR` column in PGlite, paired with `embedding_sets` metadata that tracks:
- Model identifier
- Vector dimensions
- Distance metric (cosine, l2, ip)

The authoritative model list comes from the DB `providers` and `models` tables (seeded in `migration 015-model-registry`). The fallback registry in `@brainstrike/embeddings` is used for legacy flows and tests.

### Search Collections
Each Search Collection is associated with a specific embedding set. When you:
1. Select a model in the UI
2. Create a collection
3. BrainStrike creates or reuses an embedding set with matching `{model_key, dimensions, distance}`
4. All chunks use that embedding set for consistency

`model_key` uses the `provider::modelId` format for hosted models (e.g. `openai::text-embedding-3-small`). Local models use the raw Hugging Face model ID.

### Validation
- **Write**: Repository validates chunk embeddings match the set's dimension before persisting
- **Search**: Queries verify the query vector matches the collection's dimension before executing
- **Queue**: Workers validate generated embeddings against set dimensions and job payload metadata

## Migration Notes

If switching models for existing data:
1. Create a new Search Collection with the desired model
2. Trigger backfill for your file set
3. The old collection remains searchable until you're ready to delete it

**Do not mix embeddings from different models in the same collection** - search quality will degrade significantly.

## Provider Configuration (Worker)

Embedding worker provider configs mirror the `EmbeddingProviderConfig` type:

```typescript
// OpenAI (hosted)
const config = {
  runtime: "hosted",
  provider: "openai",
  modelId: "text-embedding-3-small",
  dimensions: 768,
};

// Google (hosted)
const config = {
  runtime: "hosted",
  provider: "google",
  modelId: "text-embedding-004",
  outputDimensionality: 768,
};
```

## Performance Tips

1. **Start with the default** (`jinaai/jina-embeddings-v2-base-code`) - it's well-tested and works for most use cases
2. **Use smaller models for development/testing** (`Xenova/all-MiniLM-L6-v2` at 23MB downloads instantly)
3. **Profile before upgrading** - larger models may not always improve your specific use case
4. **Consider context window** - if your chunks exceed 512 tokens, use models with larger windows
5. **Monitor costs** - hosted models charge per token; local models have no recurring costs

## Resources

- [OpenAI Embeddings Announcement](https://openai.com/index/new-embedding-models-and-api-updates/)
- [Google Gemini API Docs](https://ai.google.dev/gemini-api/docs/embeddings)
- [Cohere Embed API](https://docs.cohere.com/reference/embed)
- [Jina AI Models](https://jina.ai/embeddings)
- [BGE Models (Hugging Face)](https://huggingface.co/BAAI)

## Related Documentation

- [Database Schema (08-data-model.md)](../architecture/08-data-model.md)
- [Embedding Dimensions Explainer](../20251019-embedding-dimensions-explainer.md)
- [Embedding Pipeline Architecture](../architecture/03-embedding-pipeline.md)
