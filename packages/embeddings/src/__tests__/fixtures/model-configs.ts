import type { ModelConfig } from '../../types';

export const JINA_CODE_MODEL: ModelConfig = {
  contextWindow: 8192,
  description: 'Code-aware embeddings (30+ languages, 8k ctx)',
  dimensions: 768,
  id: 'jinaai/jina-embeddings-v2-base-code',
  name: 'Jina Code v2 (default)',
  origin: 'transformers',
  size: '~300MB',
  tags: ['code', 'multilingual', 'open-source', 'local'],
};

export const MINILM_MODEL: ModelConfig = {
  contextWindow: 512,
  description: 'Fast and efficient English embeddings',
  dimensions: 384,
  id: 'Xenova/all-MiniLM-L6-v2',
  name: 'all-MiniLM-L6-v2',
  origin: 'transformers',
  size: '~23MB',
  tags: ['english', 'fast', 'general', 'local'],
};

export const BGE_LARGE_MODEL: ModelConfig = {
  contextWindow: 512,
  description: 'SOTA English text embeddings',
  dimensions: 1024,
  id: 'Xenova/bge-large-en-v1.5',
  name: 'BGE-Large-EN-v1.5',
  origin: 'transformers',
  quantized: false,
  size: '~330MB',
  tags: ['english', 'sota', 'bge', 'local'],
};

export const TEST_MODEL_CONFIGS = {
  BGE_LARGE_MODEL,
  JINA_CODE_MODEL,
  MINILM_MODEL,
};
