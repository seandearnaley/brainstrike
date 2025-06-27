# Changelog

All notable changes to the @brainstrike/embeddings package will be documented in this file.

## [0.1.0] - 2024-06-27

### ✨ Added - Major New Features

- **Plug-and-Play Model Registry**: JSON-based model configuration system
  - Add new models without TypeScript changes
  - 5 pre-configured models optimized for different use cases
  - Automatic quantization logic based on model dimensions

- **Jina Code Model as Default**: Optimized for code embeddings
  - 768-dimensional embeddings
  - Support for 30+ programming languages
  - 8k context window for large code chunks
  - Achieves ≥0.6 cosine similarity for code/prompt pairs

- **CLI Tool for Batch Processing**: `embed-code` command
  - Process entire codebases with automatic file discovery
  - Support for 30+ programming languages and config formats
  - Multiple output formats: JSON, CSV, PostgreSQL pgvector
  - Configurable chunking with overlap support
  - Smart file filtering and size limits

- **Cross-Platform Compatibility**:
  - Browser: WebGPU acceleration with WASM fallback
  - Node.js: CPU-optimized inference
  - Automatic device detection and fallback logic

### 🔧 Technical Improvements

- **Model Registry Manager**: Centralized model configuration
  - Type-safe model definitions
  - Tag-based model filtering
  - Dynamic registry updates for testing

- **Enhanced Service Architecture**:
  - Registry-aware initialization with `initializeWithModel()`
  - Static methods for model discovery
  - Improved error handling and progress reporting
  - Better memory management and cleanup

- **UI Integration Updates**:
  - Model dropdown populated from registry
  - Real-time model information display
  - Origin and dimension information
  - Non-default model badges

### 📊 Models Available

| Model Key | Name | Dimensions | Size | Purpose |
|-----------|------|------------|------|---------|
| `jina-code` | Jina Code (default) | 768 | ~300MB | Code embeddings |
| `all-MiniLM-L6-v2` | all-MiniLM-L6-v2 | 384 | ~23MB | Fast English text |
| `bge-small-en-v1.5` | BGE-Small-EN-v1.5 | 384 | ~67MB | Balanced English |
| `bge-base-en-v1.5` | BGE-Base-EN-v1.5 | 768 | ~130MB | High-quality English |
| `bge-large-en-v1.5` | BGE-Large-EN-v1.5 | 1024 | ~330MB | SOTA English |

### 🧪 Testing & Quality

- **Comprehensive Test Suite**:
  - Model registry validation tests
  - Similarity calculation verification
  - Cross-platform compatibility tests
  - Error handling and edge case coverage

- **Integration Tests**:
  - Model switching and initialization
  - Code vs natural language similarity
  - Semantic code similarity validation
  - Performance and memory usage tests

### 📖 Documentation

- **Complete README**: Detailed usage examples and API reference
- **CLI Documentation**: Comprehensive command-line tool guide
- **Migration Guide**: Instructions for upgrading from previous versions
- **Performance Guidelines**: Optimization recommendations
- **Troubleshooting**: Common issues and solutions

### 🔄 API Changes

#### New Methods
```typescript
// Static registry methods
SimpleEmbeddingService.listModels(): Record<string, ModelConfig>
SimpleEmbeddingService.getDefaultModelKey(): string
SimpleEmbeddingService.getModelConfig(key: string): ModelConfig | null
SimpleEmbeddingService.getRegistry(): ModelRegistry

// Instance methods
service.initializeWithModel(modelKey?: string, onProgress?: Function): Promise<void>
service.getCurrentModelKey(): string | null
service.getCurrentModelConfig(): ModelConfig | null
```

#### Enhanced Types
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

interface ModelRegistry {
  default: string;      // Default model key
  models: Record<string, ModelConfig>;
}
```

### 🛠️ CLI Tool Usage

```bash
# Basic usage
embed-code ./src --output embeddings.json

# Advanced usage
embed-code ./src \
  --model jina-code \
  --format pgvector \
  --output embeddings.sql \
  --include "**/*.ts,**/*.js" \
  --exclude "**/*.test.*" \
  --max-lines 50 \
  --chunk-overlap 5 \
  --verbose
```

### 📦 Dependencies

- **Added**: `glob@^11.0.0` for file pattern matching
- **Updated**: Enhanced TypeScript type definitions
- **Maintained**: `@huggingface/transformers@^3.6.0` compatibility

### 🐛 Bug Fixes

- Fixed UI state management issues with model loading
- Resolved TypeScript strict mode compatibility
- Improved WebGPU detection and fallback logic
- Fixed Node.js vs browser environment detection

### ⚡ Performance Optimizations

- Automatic quantization for models ≤768 dimensions
- Optimized device selection (WebGPU > WASM > CPU)
- Memory-efficient model disposal
- Intelligent chunking for large files

### 🔒 Breaking Changes

- **Model Initialization**: Recommend using `initializeWithModel()` instead of `initialize()`
- **Default Model**: Changed from BGE-M3 to Jina Code for better code support
- **Configuration**: Models now defined in `model-registry.json` instead of TypeScript constants

### 📈 Migration Path

1. **Update Imports**: No changes needed - same package exports
2. **Initialize Models**: Use `service.initializeWithModel('jina-code')` for optimal code embeddings
3. **Configuration**: Custom models should be added to `model-registry.json`
4. **CLI**: Replace any custom embedding scripts with the new `embed-code` tool

### 🎯 Performance Benchmarks

- **Jina Code Model**: 768D embeddings, ~300MB download
- **Code Similarity**: Achieves ≥0.6 cosine similarity for related code/prompt pairs
- **Processing Speed**: Handles 100-line code chunks efficiently
- **Memory Usage**: Optimized for browser environments with quantization

### 🌟 Highlights

This release represents a major evolution of the embeddings package, transforming it from a simple BGE-M3 wrapper into a comprehensive, production-ready embedding solution. The new registry system, CLI tool, and code-optimized default model make it ideal for code search, documentation generation, and semantic code analysis workflows.

The plug-and-play architecture means teams can easily add domain-specific models without code changes, while the comprehensive test suite and documentation ensure reliability and ease of use.

---

## Future Roadmap

### Planned for v0.2.0
- [ ] Semantic search integration with vector databases
- [ ] Batch embedding optimization
- [ ] Model fine-tuning utilities
- [ ] Integration with popular IDEs
- [ ] Embedding visualization tools

### Under Consideration
- [ ] Support for multimodal embeddings (text + code structure)
- [ ] Real-time embedding updates for file watchers
- [ ] Integration with popular vector databases (Pinecone, Weaviate, etc.)
- [ ] Custom model training workflows

---

For detailed usage examples and API reference, see [README.md](./README.md).