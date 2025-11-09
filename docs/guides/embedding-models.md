# Embedding Models Guide

This guide helps you choose and configure embedding models in BrainStrike. It covers both local models (running in-browser or on-device) and hosted API providers.

## Quick Start

**Default Model**: `jina-code` (768 dimensions)
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

### Local Models

Local models run entirely in your browser or desktop app using WebAssembly. No API keys or internet connection required after initial download.

#### Jina AI Models

**jina-code** (Default) ⭐
- **Dimensions**: 768
- **Size**: ~300MB
- **Context**: 8,192 tokens
- **Best for**: Code search, multi-language development
- **Languages**: 30+ programming languages

**jina-v3**
- **Dimensions**: 1024 (flexible: 256/512/768/1024)
- **Size**: ~570MB
- **Context**: 8,192 tokens
- **Best for**: Multilingual text, task-specific embeddings
- **Languages**: 89 languages

#### BGE (BAAI General Embedding) Models

**bge-small-en-v1.5**
- **Dimensions**: 384
- **Size**: ~67MB
- **Context**: 512 tokens
- **Best for**: Fast English text search, resource-constrained environments

**bge-base-en-v1.5**
- **Dimensions**: 768
- **Size**: ~130MB
- **Context**: 512 tokens
- **Best for**: High-quality English embeddings, balanced performance

**bge-large-en-v1.5**
- **Dimensions**: 1024
- **Size**: ~330MB
- **Context**: 512 tokens
- **Best for**: State-of-the-art English text quality

#### MiniLM Models

**all-MiniLM-L6-v2**
- **Dimensions**: 384
- **Size**: ~23MB (smallest!)
- **Context**: 512 tokens
- **Best for**: Ultra-fast search, minimal storage, English text

### Hosted Models (API Required)

Hosted models require API keys and internet connectivity but offer cutting-edge performance.

#### OpenAI

**text-embedding-3-small**
- **Dimensions**: 1536 (flexible: 256-1536)
- **Context**: 8,191 tokens
- **Cost**: $0.02 per 1M tokens
- **Best for**: Cost-effective hosted solution

**text-embedding-3-large**
- **Dimensions**: 3072 (flexible: 256-3072)
- **Context**: 8,191 tokens
- **Cost**: $0.13 per 1M tokens
- **Best for**: Best-in-class performance for production applications

#### Google

**gemini-embedding-001**
- **Dimensions**: 3072 (flexible: 128-3072)
- **Context**: 2,048 tokens
- **Cost**: $0.15 per 1M tokens
- **Best for**: Multilingual high-performance search
- **Note**: Use `output_dimensionality` parameter to customize

**text-embedding-004** (Deprecated)
- **Dimensions**: 768
- **Deprecated**: January 2026
- **Use gemini-embedding-001 instead**

#### Voyage AI

**voyage-3**
- **Dimensions**: 1024
- **Context**: 32,000 tokens
- **Cost**: $0.06 per 1M tokens
- **Best for**: Long-context multilingual retrieval

**voyage-3-lite**
- **Dimensions**: 512
- **Context**: 32,000 tokens
- **Cost**: $0.02 per 1M tokens
- **Best for**: Budget-conscious long-context applications

#### Cohere

**embed-english-v3.0**
- **Dimensions**: 1024
- **Context**: 512 tokens
- **Cost**: $0.50 per 1M tokens
- **Best for**: English-optimized with input_type support

**embed-multilingual-v3.0**
- **Dimensions**: 1024
- **Context**: 512 tokens
- **Cost**: $0.50 per 1M tokens
- **Best for**: Cross-lingual search (100+ languages)

## Choosing a Model

### For Code Search
- **Primary**: `jina-code` (default, code-aware)
- **Alternative**: `bge-base-en-v1.5` (English codebases)

### For General Text
- **Fastest**: `all-MiniLM-L6-v2` (384D, 23MB)
- **Balanced**: `bge-base-en-v1.5` (768D, quality/speed)
- **Best Quality**: `bge-large-en-v1.5` (1024D, SOTA)

### For Multilingual Content
- **Local**: `jina-v3` (89 languages, flexible dimensions)
- **Hosted**: `gemini-embedding-001` (best quality) or `cohere embed-multilingual-v3.0`

### For Production/Hosted
- **Cost-effective**: OpenAI `text-embedding-3-small` ($0.02/1M tokens)
- **Best performance**: OpenAI `text-embedding-3-large` or Google `gemini-embedding-001`
- **Long context**: Voyage `voyage-3` (32k tokens)

## Flexible Dimensions

Some models support flexible output dimensions:

| Model | Supported Dimensions |
|-------|---------------------|
| OpenAI text-embedding-3-small | 256-1536 |
| OpenAI text-embedding-3-large | 256-3072 |
| Google gemini-embedding-001 | 128-3072 |
| Jina v3 | 256, 512, 768, 1024 |

**When to use lower dimensions:**
- Reduce storage costs
- Faster similarity search
- Resource-constrained environments

**Trade-off**: Lower dimensions may reduce search quality for some queries.

## Technical Details

### Database Schema
BrainStrike uses a dimensionless `VECTOR` column in PGlite, paired with `embedding_sets` metadata that tracks:
- Model identifier
- Vector dimensions
- Distance metric (cosine, euclidean, etc.)

This architecture allows multiple models/dimensions within the same database without schema migrations.

### Search Collections
Each Search Collection is associated with a specific embedding set. When you:
1. Select a model in the UI
2. Start backfill
3. BrainStrike creates or reuses an embedding set with matching `{model_key, dimensions, distance}`
4. All chunks use that embedding set for consistency

### Validation
- **Write**: Repository validates chunk embeddings match the set's dimension before persisting
- **Search**: Queries verify the query vector matches the collection's dimension before executing
- **Queue**: Workers validate generated embeddings against `expectedDimension` metadata

## Migration Notes

If switching models for existing data:
1. Create a new Search Collection with the desired model
2. Trigger backfill for your file set
3. The old collection remains searchable until you're ready to delete it

**Do not mix embeddings from different models in the same collection** - search quality will degrade significantly.

## API Configuration

### OpenAI
```typescript
// Customize dimensions (256-1536 for small, 256-3072 for large)
const response = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: "Your text here",
  dimensions: 768 // Optional: reduce from 1536 default
});
```

### Google Gemini
```typescript
// Use output_dimensionality for custom dimensions
const response = await genai.embedContent({
  model: "gemini-embedding-001",
  content: "Your text here",
  outputDimensionality: 768 // Optional: reduce from 3072 default
});
```

### Cohere
```typescript
// Specify output_dimension (256/512/1024/1536)
const response = await cohere.embed({
  model: "embed-english-v3.0",
  texts: ["Your text here"],
  output_dimension: 768 // Optional
});
```

## Performance Tips

1. **Start with the default** (`jina-code`) - it's well-tested and works for most use cases
2. **Use smaller models for development/testing** (`all-MiniLM-L6-v2` at 23MB downloads instantly)
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
