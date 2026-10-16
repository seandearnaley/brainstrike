/**
 * The built-in `local` provider's remaining half: an on-device EMBEDDING model.
 *
 * Its chat half (Gemma 4 E2B through transformers.js, the `LocalLlmBackend`
 * singleton and the llm-host proxy chat model) was retired — see the provider
 * catalog, where `local` now declares `capabilities.llm: false`.
 */

export {
  createLocalHostEmbeddingModel,
  type LocalEmbeddingHostClient,
  type LocalEmbeddingHostQuery,
} from './local-host-embedding-model';
