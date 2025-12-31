import type { ModelConfig } from '../../types';

export const JINA_CODE_MODEL: ModelConfig = {
  id: 'jinaai/jina-embeddings-v2-base-code',
  name: 'Jina Code v2 (default)',
  dimensions: 768,
  description: 'Code-aware embeddings (30+ languages, 8k ctx)',
  tags: ['code', 'multilingual', 'open-source', 'local'],
  origin: 'transformers',
  size: '~300MB',
  contextWindow: 8192,
};

export const MINILM_MODEL: ModelConfig = {
  id: 'Xenova/all-MiniLM-L6-v2',
  name: 'all-MiniLM-L6-v2',
  dimensions: 384,
  description: 'Fast and efficient English embeddings',
  tags: ['english', 'fast', 'general', 'local'],
  origin: 'transformers',
  size: '~23MB',
  contextWindow: 512,
};

export const BGE_LARGE_MODEL: ModelConfig = {
  id: 'Xenova/bge-large-en-v1.5',
  name: 'BGE-Large-EN-v1.5',
  dimensions: 1024,
  quantized: false,
  description: 'SOTA English text embeddings',
  tags: ['english', 'sota', 'bge', 'local'],
  origin: 'transformers',
  size: '~330MB',
  contextWindow: 512,
};

export const TEST_MODEL_CONFIGS = {
  JINA_CODE_MODEL,
  MINILM_MODEL,
  BGE_LARGE_MODEL,
};
