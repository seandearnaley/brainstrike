# @brainstrike/embeddings

Embedding providers, worker orchestration, and validation utilities for BrainStrike. Supports local transformers.js models (renderer-only) and hosted providers (OpenAI/Google in the worker today) with a DB-backed model registry and a fallback registry for CLI/tests.

## Features

- 🧠 **Multi-Provider Support**: Local transformers.js + hosted providers via a unified factory
- 🗂️ **DB Model Registry**: `providers`/`models` tables are the source of truth; fallback registry for CLI/tests
- 🧵 **Embedding Worker**: `startEmbeddingWorker()` processes durable JobQueue tasks with retries
- ⚙️ **Device Detection**: Explicit WebGPU/WASM selection with actionable errors (no silent fallback)
- ✅ **Validation Helpers**: Embedding set + dimension validation utilities
- 📊 **CLI Tooling**: Batch embedding CLI for local workflows (legacy registry)

## Installation

The embeddings service is delivered as a workspace package. Link it into the
consumer workspace via pnpm.

```bash
# Add to a specific workspace (example: apps/desktop)
pnpm add @brainstrike/embeddings --filter @brainstrike/desktop

# Or declare it manually inside the target package.json
"dependencies": {
  "@brainstrike/embeddings": "workspace:*"
}
```

## Models Available

Model availability in the apps is driven by the DB registry (`providers` + `models` tables) and Settings. The table below reflects the fallback registry used by `SimpleEmbeddingService` and the CLI.

| Model Key | Dimensions | Size | Notes |
|-----------|------------|------|-------|
| **jinaai/jina-embeddings-v2-base-code** (default) | 768 | ~300MB | code, multilingual |
| Xenova/jina-embeddings-v2-base-en | 768 | ~130MB | general English |
| jinaai/jina-embeddings-v3 (experimental) | 1024 | ~570MB | multilingual, experimental |
| Xenova/all-MiniLM-L6-v2 | 384 | ~23MB | fast English |
| Xenova/bge-small-en-v1.5 | 384 | ~67MB | balanced English |
| Xenova/bge-base-en-v1.5 | 768 | ~130MB | high-quality English |
| Xenova/bge-large-en-v1.5 | 1024 | ~330MB | SOTA English |

## Quick Start

### Worker Integration (App)

```typescript
import { startEmbeddingWorker } from '@brainstrike/embeddings';
import type { IDatabase } from '@brainstrike/db';

const controller = await startEmbeddingWorker({
  db, // PGlite instance
  enable: true,
  device: 'webgpu', // or 'wasm'
  // Optional fallback model key (jobs should supply embeddingSetId + modelKey)
  // Use provider::modelId for hosted (e.g., openai::text-embedding-3-small)
  modelKey: 'jinaai/jina-embeddings-v2-base-code',
});

// Jobs are enqueued into JobQueue with embeddingSetId + modelKey; the worker
// resolves model metadata from the DB `models` table and validates dimensions.
// Pass `embeddingCache` to enable content-level deduplication (optional).
```

### Basic Usage

```typescript
import { SimpleEmbeddingService } from '@brainstrike/embeddings';

const service = new SimpleEmbeddingService();

// Initialize with default Jina Code model
await service.initializeWithModel();

// Generate embeddings (document/passages)
const result = await service.generateDocEmbedding('function add(a, b) { return a + b; }');
console.log(`Embedding: ${result.dimensions}D vector`);

// Calculate similarity
const code = 'def factorial(n): return 1 if n <= 1 else n * factorial(n-1)';
const prompt = 'Calculate factorial recursively';

const codeEmbedding = await service.generateDocEmbedding(code);
const promptEmbedding = await service.generateQueryEmbedding(prompt);

const similarity = service.calculateSimilarity(
  codeEmbedding.embedding,
  promptEmbedding.embedding
);

console.log(`Similarity: ${(similarity.similarity * 100).toFixed(1)}%`);

// Clean up
await service.dispose();
```

Note: `SimpleEmbeddingService` uses the fallback registry and is primarily intended for local tooling/tests. The production apps run embeddings via `startEmbeddingWorker()` + JobQueue using DB-backed model metadata.

### Model Selection

```typescript
// List available models
const models = SimpleEmbeddingService.listModels(); // legacy registry
console.log(Object.keys(models)); // ['jinaai/jina-embeddings-v2-base-code', ...]

// Initialize with specific model
await service.initializeWithModel('Xenova/bge-small-en-v1.5');

// Get model info
const modelConfig = service.getCurrentModelConfig();
console.log(`Using ${modelConfig.name} (${modelConfig.dimensions}D)`);
```

### React Integration

```typescript
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { useState, useEffect } from 'react';

function EmbeddingComponent() {
  const [service] = useState(() => new SimpleEmbeddingService());
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    const initialize = async () => {
      setStatus('initializing');
      await service.initializeWithModel('jinaai/jina-embeddings-v2-base-code', (progress) => {
        console.log(`${progress.stage}: ${progress.progress}%`);
      });
      setStatus('ready');
    };

    initialize();
    return () => service.dispose();
  }, [service]);

  const handleEmbed = async (text: string) => {
    if (status === 'ready') {
      const result = await service.generateDocEmbedding(text);
      return result.embedding;
    }
  };

  return <div>Status: {status}</div>;
}
```

## CLI Tool

The package includes a powerful CLI tool for batch processing code files:

### Running the CLI from the workspace

```bash
# Show help
pnpm --filter @brainstrike/embeddings exec embed-code --help

# Example invocation
pnpm --filter @brainstrike/embeddings exec embed-code ./src --output embeddings.json
```

### Basic Usage

```bash
# Embed all code files in src/ directory
embed-code ./src --output embeddings.json

# Use specific model
embed-code ./src --model jinaai/jina-embeddings-v2-base-code --format pgvector --output embeddings.sql

# Custom file patterns
embed-code ./src --include "**/*.ts,**/*.js" --exclude "**/*.test.*"

# Verbose output with custom chunking
embed-code ./src --verbose --max-lines 50 --chunk-overlap 5
```

### Output Formats

#### JSON Format
```json
[
  {
    "id": "utils/helpers.ts:1-25",
    "filePath": "utils/helpers.ts",
    "language": "typescript",
    "content": "export function debounce(fn: Function, delay: number) {...}",
    "startLine": 1,
    "endLine": 25,
    "embedding": [0.1234, -0.5678, ...],
    "dimensions": 768,
    "model": "Xenova/jina-embeddings-v2-base-code",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
]
```

#### PostgreSQL with pgvector
```sql
INSERT INTO code_embeddings (id, file_path, language, start_line, end_line, content, embedding, model, created_at) 
VALUES ('utils/helpers.ts:1-25', 'utils/helpers.ts', 'typescript', 1, 25, 
$code$export function debounce(fn: Function, delay: number) {...}$code$, 
'[0.1234,-0.5678,...]'::vector, 'Xenova/jina-embeddings-v2-base-code', '2024-01-15T10:30:00.000Z');
```

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--model <key>` | Model from registry | jinaai/jina-embeddings-v2-base-code |
| `--format <format>` | Output format: json, csv, pgvector | json |
| `--output <file>` | Output file path | stdout |
| `--include <patterns>` | File patterns to include | See supported languages |
| `--exclude <patterns>` | File patterns to exclude | node_modules, dist, etc. |
| `--max-file-size <bytes>` | Maximum file size | 1048576 (1MB) |
| `--max-lines <count>` | Lines per chunk | 100 |
| `--chunk-overlap <count>` | Overlap between chunks | 10 |
| `--verbose` | Enable detailed logging | false |

## Adding New Models

For app usage, add entries to the DB-backed model registry (tables `providers` and `models`, seeded in `migration 015-model-registry`) and enable them in Settings → Embeddings.

For CLI/tests, update the fallback registry in `packages/embeddings/src/model-registry.ts` or pass a `ModelConfig` directly to `SimpleEmbeddingService.initializeWithModel()`.

## Supported Languages

The CLI tool automatically detects and processes these file types:

**Programming Languages:**
- JavaScript/TypeScript (`.js`, `.jsx`, `.ts`, `.tsx`)
- Python (`.py`)
- Java (`.java`)
- C/C++ (`.c`, `.cpp`, `.h`, `.hpp`)
- C# (`.cs`)
- Go (`.go`)
- Rust (`.rs`)
- Ruby (`.rb`)
- PHP (`.php`)
- Swift (`.swift`)
- Kotlin (`.kt`)
- Scala (`.scala`)
- R (`.r`)

**Markup & Config:**
- HTML (`.html`)
- CSS/SCSS/Sass (`.css`, `.scss`, `.sass`)
- JSON (`.json`)
- YAML (`.yml`, `.yaml`)
- TOML (`.toml`)
- XML (`.xml`)
- SQL (`.sql`)

**Shell Scripts:**
- Bash/Zsh/Fish (`.sh`, `.bash`, `.zsh`, `.fish`)
- PowerShell (`.ps1`)

**Frameworks:**
- Vue (`.vue`)
- Svelte (`.svelte`)
- Dockerfile

## API Reference

### SimpleEmbeddingService

#### Static Methods

```typescript
// Get all available models
static listModels(): Record<string, ModelConfig>

// Get default model key
static getDefaultModelKey(): string

// Get specific model configuration
static getModelConfig(key: string): ModelConfig | null

// Get the complete registry
static getRegistry(): ModelRegistry
```

#### Instance Methods

```typescript
// Initialize with model from registry
async initializeWithModel(
  modelKey?: string,
  onProgress?: (progress: EmbeddingProgress) => void
): Promise<void>

// Generate embedding for text
async generateEmbedding(text: string): Promise<EmbeddingResult>

// Calculate cosine similarity
calculateSimilarity(
  embedding1: number[], 
  embedding2: number[]
): SimilarityResult

// Get current status
getStatus(): EmbeddingStatus

// Get current configuration
getConfig(): EmbeddingConfig

// Get currently loaded model
getCurrentModelKey(): string | null
getCurrentModelConfig(): ModelConfig | null

// Clean up resources
async dispose(): Promise<void>
```

### Types

```typescript
interface ModelConfig {
  id: string;           // Hugging Face model ID
  name: string;         // Display name
  dimensions: number;   // Embedding dimensions
  quantized: boolean;   // Use quantization
  description: string;  // Model description
  tags: string[];       // Category tags
  origin: string;       // Model origin/type
  size: string;         // Download size
}

interface EmbeddingResult {
  embedding: number[];  // Vector embedding
  dimensions: number;   // Vector dimensions
  model: string;        // Model ID used
}

interface SimilarityResult {
  similarity: number;   // Cosine similarity (0-1)
  distance: number;     // Distance (0-2)
  method: 'cosine';     // Method used
}

type EmbeddingStatus = 
  | 'idle' | 'initializing' | 'downloading' 
  | 'ready' | 'processing' | 'error' | 'disposed';
```

## Performance Optimization

### Memory Management & Thresholds
The embeddings service includes configurable memory thresholds to prevent browser crashes and optimize performance:

#### Configurable Memory Limits
```typescript
// Default memory thresholds (configurable)
const MEMORY_THRESHOLDS = {
  MAX_FILE_SIZE: 1048576,        // 1MB per file (configurable via CLI --max-file-size)
  MAX_CACHE_ENTRIES: 50,         // Maximum cached embeddings (configurable)
  MAX_MEMORY_USAGE: 52428800,    // 50MB memory limit (configurable)
  CHUNK_SIZE: 100,               // Lines per chunk (configurable via CLI --max-lines)
  CHUNK_OVERLAP: 10              // Overlap between chunks (configurable via CLI --chunk-overlap)
};
```

#### Memory Optimization Strategies
- **Automatic Cleanup**: Call `dispose()` to free model memory
- **Chunk Processing**: Large files are processed in configurable chunks
- **Cache Management**: LRU eviction when cache exceeds entry limits
- **Memory Monitoring**: Built-in memory usage tracking and warnings

### Browser Environment
- **WebGPU**: Auto-selected when available for fastest inference
- **WASM**: Must be selected explicitly when WebGPU is unavailable
- **Quantization**: Automatic for models ≤768 dimensions
- **Caching**: Models cached by transformers.js with configurable limits
- **Memory Pressure**: Automatic model unloading under memory constraints

### Node.js Environment
- **Local models**: Not recommended in main/Node contexts (requires Web Workers)
- **Hosted providers**: Preferred outside the renderer
- **Override**: Set `EMBED_ALLOW_LOCAL_IN_MAIN=true` if you must run local models in Node

### Model Selection Guidelines
- **jinaai/jina-embeddings-v2-base-code**: Best for code similarity and search
- **Xenova/all-MiniLM-L6-v2**: Fastest for general text (English only)
- **Xenova/bge-small-en-v1.5**: Good balance of speed and quality
- **Xenova/bge-base-en-v1.5**: Higher quality, moderate speed
- **Xenova/bge-large-en-v1.5**: Best quality, slower inference

## Integration Examples

### Search Similar Code
```typescript
const codeChunks = await embedAllCodeFiles('./src');
const queryEmbedding = await service.generateEmbedding('authentication middleware');

const results = codeChunks
  .map(chunk => ({
    ...chunk,
    similarity: service.calculateSimilarity(queryEmbedding.embedding, chunk.embedding).similarity
  }))
  .sort((a, b) => b.similarity - a.similarity)
  .slice(0, 10);
```

### Code Documentation Generator
```typescript
async function generateDocumentation(codeSnippet: string) {
  const codeEmbedding = await service.generateEmbedding(codeSnippet);
  
  // Find similar documented code
  const similarities = documentedExamples.map(example => ({
    ...example,
    similarity: service.calculateSimilarity(codeEmbedding.embedding, example.embedding).similarity
  }));
  
  const bestMatch = similarities.sort((a, b) => b.similarity - a.similarity)[0];
  return bestMatch.similarity > 0.7 ? bestMatch.documentation : null;
}
```

### Code Review Assistant
```typescript
async function findSimilarPatterns(newCode: string, existingCodebase: CodeChunk[]) {
  const newCodeEmbedding = await service.generateEmbedding(newCode);
  
  const similarPatterns = existingCodebase
    .filter(chunk => {
      const similarity = service.calculateSimilarity(
        newCodeEmbedding.embedding, 
        chunk.embedding
      ).similarity;
      return similarity > 0.8; // High similarity threshold
    })
    .map(chunk => ({ ...chunk, filePath: chunk.filePath }));
    
  return similarPatterns;
}
```

## Migration Guide

### From Previous BGE-M3 Implementation

1. **Update imports** - No changes needed, same API
2. **Model initialization** - Replace with `initializeWithModel('jinaai/jina-embeddings-v2-base-code')`
3. **Configuration** - Models now configured via DB registry (providers/models) or fallback registry for CLI/tests
4. **Performance** - Jina Code model is smaller and faster than BGE-M3

### From External Embedding Services

1. **Replace API calls** with local embedding generation
2. **Update similarity calculation** to use built-in cosine similarity
3. **Migrate model configuration** to DB registry (or fallback registry for CLI)
4. **Update CLI scripts** to use new embed-code tool

## Troubleshooting

### Common Issues & Solutions

#### Model Loading Issues
**"Model not found in registry"**
- Check model key spelling and case sensitivity
- Verify model exists in the DB `models` table (Settings → Embeddings)
- Use `SimpleEmbeddingService.listModels()` for fallback registry keys
- Ensure the model registry store has loaded

**"Failed to fetch model"**
- Check internet connection for model downloads
- Models are cached after first download - try clearing browser cache
- Try a smaller model like `Xenova/all-MiniLM-L6-v2` for testing
- Verify Hugging Face model IDs are correct

**"Unsupported device: wasm"**
- Set `device: "wasm"` explicitly when WebGPU is unavailable
- Ensure transformers.js is properly loaded in the browser
- Check browser compatibility for WebAssembly support
- Local models should run in a renderer/browser context; use hosted providers in main/Node

#### Memory & Performance Issues
**Memory issues in browser**
- Use quantized models (automatic for ≤768D models)
- Call `dispose()` when service is no longer needed
- Reduce `MAX_CACHE_ENTRIES` for memory-constrained environments
- Process files in smaller chunks using `--max-lines` parameter

**"Out of memory" errors**
- Reduce `MAX_FILE_SIZE` limit for large files
- Increase `CHUNK_SIZE` to process files in smaller pieces
- Monitor memory usage with browser DevTools
- Consider using smaller models for large-scale processing

**Slow inference performance**
- Enable WebGPU when available (automatic detection)
- Use smaller models for faster inference
- Reduce chunk overlap to minimize processing overhead
- Check system resources and close unnecessary applications

#### Configuration & Environment Issues
**"Cannot initialize service"**
- Verify all required dependencies are installed
- Check browser console for detailed error messages
- Ensure proper environment setup (Node.js vs browser)
- Try initializing with a different model

**CLI tool failures**
- Verify file paths and permissions
- Check output directory exists and is writable
- Ensure sufficient disk space for output files
- Use `--verbose` flag for detailed error information

**Workspace linking issues**
- Ensure package is properly linked: `pnpm add @brainstrike/embeddings --filter <target>`
- Check `package.json` dependencies include `"@brainstrike/embeddings": "workspace:*"`
- Verify Turborepo workspace configuration
- Run `pnpm install` to refresh workspace links

### Debug Mode & Logging

#### Enable Verbose Logging
```typescript
// In code - enable progress callbacks
await service.initializeWithModel('jinaai/jina-embeddings-v2-base-code', (progress) => {
  console.log(`${progress.stage}: ${progress.message} (${progress.progress}%)`);
});

// CLI - enable detailed output
embed-code ./src --verbose
```

#### Browser DevTools Debugging
```typescript
// Monitor memory usage
console.log('Memory usage:', performance.memory);

// Check service status
console.log('Service status:', service.getStatus());
console.log('Current model:', service.getCurrentModelConfig());
```

#### Common Error Patterns
1. **Network Issues**: Check connectivity, try different models, verify CDN access
2. **Memory Constraints**: Reduce file sizes, use smaller models, enable cleanup
3. **Browser Compatibility**: Check WebAssembly support, try different browsers
4. **Configuration Errors**: Verify model registry, check environment variables
5. **Performance Issues**: Enable WebGPU, use quantized models, optimize chunks

## Testing

The package includes two types of tests:

### Unit Tests (Fast)
Run by default - test the model registry and similarity calculations without downloading models:
```bash
pnpm test
# or
npx vitest run
```

### Integration Tests (Slow)
Test actual model downloading and embedding generation. Requires internet connection and downloads ~300MB+ of models:
```bash
pnpm test:models
# or
VITEST_RUN_INTEGRATION=true npx vitest run
```

**Note**: Integration tests are skipped by default in CI/development to avoid long test times and large downloads.

## Contributing

To add new models or features:

1. **Models**: Update DB registry seeds (`providers`/`models`) or the fallback registry in `packages/embeddings/src/model-registry.ts`
2. **Tests**: Add test cases in `__tests__/`
3. **Documentation**: Update this README
4. **Types**: Extend interfaces in `src/provider-types.ts` if needed

## License

MIT License - see LICENSE file for details.

## Changelog

### v0.1.0 (Current)
- ✨ Initial release with Jina Code as default model
- 🔧 Plug-and-play model registry system
- 📊 CLI tool with JSON/CSV/pgvector export
- 🧪 Comprehensive test suite
- 📖 Complete documentation
- 🌐 Browser and Node.js compatibility
- ⚡ Automatic quantization and device detection
