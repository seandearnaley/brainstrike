import type { ModelConfig } from '../../types.js';

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
