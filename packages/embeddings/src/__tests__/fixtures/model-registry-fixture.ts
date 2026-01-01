import type { HostedModelConfig, ModelConfig, ModelRegistry } from '../../types';
import { BGE_LARGE_MODEL, JINA_CODE_MODEL, MINILM_MODEL } from './model-configs';

const JINA_REGISTRY_MODEL: ModelConfig = { ...JINA_CODE_MODEL, quantized: false };
const MINILM_REGISTRY_MODEL: ModelConfig = { ...MINILM_MODEL, quantized: false };
const BGE_LARGE_REGISTRY_MODEL: ModelConfig = { ...BGE_LARGE_MODEL, quantized: false };

const BGE_SMALL_REGISTRY_MODEL: ModelConfig = {
  id: 'Xenova/bge-small-en-v1.5',
  name: 'BGE-Small-EN-v1.5',
  dimensions: 384,
  quantized: false,
  description: 'Balanced English embeddings',
  tags: ['english', 'balanced', 'bge', 'local'],
  origin: 'transformers',
  size: '~67MB',
  contextWindow: 512,
};

const OPENAI_SMALL: HostedModelConfig = {
  name: 'OpenAI Embedding 3 Small',
  dimensions: 1536,
  description: 'Cost-effective OpenAI model with flexible dimensions',
  tags: ['openai', 'hosted', 'cost-optimized', 'flexible-dimensions'],
  contextWindow: 8191,
  pricePer1MTokens: 0.02,
  supportedDimensions: '256-1536',
};

const OPENAI_LARGE: HostedModelConfig = {
  name: 'OpenAI Embedding 3 Large',
  dimensions: 3072,
  description: 'Best-performing OpenAI model with flexible dimensions',
  tags: ['openai', 'hosted', 'high-performance', 'flexible-dimensions'],
  contextWindow: 8191,
  pricePer1MTokens: 0.13,
  supportedDimensions: '256-3072',
};

const VOYAGE_3: HostedModelConfig = {
  name: 'Voyage 3',
  dimensions: 1024,
  description: 'General-purpose multilingual retrieval (32k context)',
  tags: ['voyage', 'hosted', 'multilingual', 'long-context'],
  contextWindow: 32_000,
  pricePer1MTokens: 0.06,
};

const COHERE_ENGLISH: HostedModelConfig = {
  name: 'Cohere Embed English v3.0',
  dimensions: 1024,
  description: 'Best English embedding model from Cohere',
  tags: ['cohere', 'hosted', 'english', 'high-performance'],
  contextWindow: 512,
  pricePer1MTokens: 0.1,
};

export const TEST_MODEL_REGISTRY: ModelRegistry = {
  default: JINA_REGISTRY_MODEL.id,
  models: {
    [JINA_REGISTRY_MODEL.id]: JINA_REGISTRY_MODEL,
    [MINILM_REGISTRY_MODEL.id]: MINILM_REGISTRY_MODEL,
    [BGE_SMALL_REGISTRY_MODEL.id]: BGE_SMALL_REGISTRY_MODEL,
    [BGE_LARGE_REGISTRY_MODEL.id]: BGE_LARGE_REGISTRY_MODEL,
  },
  hosted: {
    openai: {
      'text-embedding-3-small': OPENAI_SMALL,
      'text-embedding-3-large': OPENAI_LARGE,
    },
    voyage: {
      'voyage-3': VOYAGE_3,
    },
    cohere: {
      'embed-english-v3.0': COHERE_ENGLISH,
    },
  },
};

export const TEST_MODEL_KEYS = {
  jinaCode: JINA_REGISTRY_MODEL.id,
  miniLm: MINILM_REGISTRY_MODEL.id,
  bgeSmall: BGE_SMALL_REGISTRY_MODEL.id,
  bgeLarge: BGE_LARGE_REGISTRY_MODEL.id,
  openaiSmall: 'openai::text-embedding-3-small',
  openaiLarge: 'openai::text-embedding-3-large',
  voyage3: 'voyage::voyage-3',
  cohereEnglish: 'cohere::embed-english-v3.0',
} as const;
