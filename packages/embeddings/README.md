# @brainstrike/embeddings

A comprehensive embedding service package for BrainStrike that provides text and code embeddings using transformers.js. Features a plug-and-play model registry system with browser and Node.js compatibility.

## Features

- 🧠 **Multi-Model Support**: 5 pre-configured models optimized for different use cases
- 🔧 **Plug-and-Play**: Add new models via JSON configuration (no TypeScript changes needed)
- 🌐 **Cross-Platform**: Works in browsers (WebGPU/WASM) and Node.js (CPU)
- 💻 **Code-Aware**: Default Jina model optimized for 30+ programming languages
- 🎯 **High Similarity**: Achieves ≥0.6 cosine similarity for code/prompt pairs
- 📊 **Export Ready**: CLI tool supports JSON, CSV, and PostgreSQL pgvector formats
- ⚡ **Optimized**: Automatic quantization for browser stability

## Models Available

| Model | Dimensions | Size | Best For | Tags |
|-------|------------|------|----------|------|
| **Jina Code (default)** | 768 | ~300MB | Code embeddings (30+ languages) | code, multilingual |
| all-MiniLM-L6-v2 | 384 | ~23MB | Fast English text | english, fast |
| BGE-Small-EN-v1.5 | 384 | ~67MB | Balanced English | english, balanced |
| BGE-Base-EN-v1.5 | 768 | ~130MB | High-quality English | english, high-quality |
| BGE-Large-EN-v1.5 | 1024 | ~330MB | SOTA English text | english, sota |

## Quick Start

### Basic Usage

```typescript
import { SimpleEmbeddingService } from '@brainstrike/embeddings';

const service = new SimpleEmbeddingService();

// Initialize with default Jina Code model
await service.initializeWithModel();

// Generate embeddings
const result = await service.generateEmbedding('function add(a, b) { return a + b; }');
console.log(`Embedding: ${result.dimensions}D vector`);

// Calculate similarity
const code = 'def factorial(n): return 1 if n <= 1 else n * factorial(n-1)';
const prompt = 'Calculate factorial recursively';

const codeEmbedding = await service.generateEmbedding(code);
const promptEmbedding = await service.generateEmbedding(prompt);

const similarity = service.calculateSimilarity(
  codeEmbedding.embedding,
  promptEmbedding.embedding
);

console.log(`Similarity: ${(similarity.similarity * 100).toFixed(1)}%`);

// Clean up
await service.dispose();
```

### Model Selection

```typescript
// List available models
const models = SimpleEmbeddingService.listModels();
console.log(Object.keys(models)); // ['jina-code', 'all-MiniLM-L6-v2', ...]

// Initialize with specific model
await service.initializeWithModel('bge-small-en-v1.5');

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
      await service.initializeWithModel('jina-code', (progress) => {
        console.log(`${progress.stage}: ${progress.progress}%`);
      });
      setStatus('ready');
    };

    initialize();
    return () => service.dispose();
  }, [service]);

  const handleEmbed = async (text: string) => {
    if (status === 'ready') {
      const result = await service.generateEmbedding(text);
      return result.embedding;
    }
  };

  return <div>Status: {status}</div>;
}
```

## CLI Tool

The package includes a powerful CLI tool for batch processing code files:

### Installation

```bash
# Install globally
npm install -g @brainstrike/embeddings

# Or use directly
npx @brainstrike/embeddings embed-code --help
```

### Basic Usage

```bash
# Embed all code files in src/ directory
embed-code ./src --output embeddings.json

# Use specific model
embed-code ./src --model jina-code --format pgvector --output embeddings.sql

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
| `--model <key>` | Model from registry | jina-code |
| `--format <format>` | Output format: json, csv, pgvector | json |
| `--output <file>` | Output file path | stdout |
| `--include <patterns>` | File patterns to include | See supported languages |
| `--exclude <patterns>` | File patterns to exclude | node_modules, dist, etc. |
| `--max-file-size <bytes>` | Maximum file size | 1048576 (1MB) |
| `--max-lines <count>` | Lines per chunk | 100 |
| `--chunk-overlap <count>` | Overlap between chunks | 10 |
| `--verbose` | Enable detailed logging | false |

## Adding New Models

Simply update `model-registry.json` - no TypeScript changes needed:

```json
{
  "default": "jina-code",
  "models": {
    "your-new-model": {
      "id": "Xenova/your-model-id",
      "name": "Your Model Name",
      "dimensions": 512,
      "quantized": true,
      "description": "Description of your model",
      "tags": ["custom", "specialized"],
      "origin": "Custom",
      "size": "~200MB"
    }
  }
}
```

The model will automatically appear in the UI and be available via CLI.

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

### Browser Environment
- **WebGPU**: Automatically used when available for fastest inference
- **WASM Fallback**: Used when WebGPU unavailable
- **Quantization**: Automatic for models ≤768 dimensions
- **Caching**: Models cached by transformers.js

### Node.js Environment
- **CPU Inference**: Optimized for server environments
- **Memory Management**: Proper cleanup with `dispose()`
- **Chunk Processing**: Configurable chunk sizes for large files

### Model Selection Guidelines
- **Jina Code**: Best for code similarity and search
- **all-MiniLM-L6-v2**: Fastest for general text (English only)
- **BGE-Small**: Good balance of speed and quality
- **BGE-Base**: Higher quality, moderate speed
- **BGE-Large**: Best quality, slower inference

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
2. **Model initialization** - Replace with `initializeWithModel('jina-code')`
3. **Configuration** - Models now configured via JSON registry
4. **Performance** - Jina Code model is smaller and faster than BGE-M3

### From External Embedding Services

1. **Replace API calls** with local embedding generation
2. **Update similarity calculation** to use built-in cosine similarity
3. **Migrate model configuration** to registry format
4. **Update CLI scripts** to use new embed-code tool

## Troubleshooting

### Common Issues

**"Model not found in registry"**
- Check model key spelling
- Verify model exists in `model-registry.json`
- Use `SimpleEmbeddingService.listModels()` to see available models

**"Unsupported device: wasm"**
- In Node.js, service automatically falls back to CPU
- In browser, ensure transformers.js is properly loaded

**"Failed to fetch" errors**
- Check internet connection for model downloads
- Models are cached after first download
- Try a smaller model like `all-MiniLM-L6-v2`

**Memory issues in browser**
- Use quantized models (automatic for ≤768D)
- Dispose service when not needed
- Consider smaller models for memory-constrained environments

### Debug Mode

Enable verbose logging:

```typescript
// In code
await service.initializeWithModel('jina-code', (progress) => {
  console.log(`${progress.stage}: ${progress.message} (${progress.progress}%)`);
});

// CLI
embed-code ./src --verbose
```

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
pnpm test:integration
# or
VITEST_RUN_INTEGRATION=true npx vitest run
```

**Note**: Integration tests are skipped by default in CI/development to avoid long test times and large downloads.

## Contributing

To add new models or features:

1. **Models**: Update `model-registry.json`
2. **Tests**: Add test cases in `__tests__/`
3. **Documentation**: Update this README
4. **Types**: Extend interfaces in `src/types.ts` if needed

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