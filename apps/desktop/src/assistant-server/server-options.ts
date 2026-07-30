// Deliberately separate from the service package's types floor
// (@brainstrike/assistant-service/types): the options interface type-depends
// on five siblings, and housing it here keeps the shared types floor a true
// leaf — nobody importing @brainstrike/assistant-service/types inherits
// these edges, and no silent
// invariant ("everyone remembers import type") is required (#2111 review).

import type { AssistantLlmHostManager } from '@brainstrike/assistant-service/ports';
import type { DesktopEnvLoadFailure } from '../desktop-env';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import type { AssistantServerAuth } from './auth';
import type { OpenRouterModelMetadataService } from './openrouter-model-metadata';

export interface AssistantServerOptions {
  /**
   * Request auth. `startAssistantServer` mints a per-boot token when unset;
   * `handleAssistantRequest` throws when unset (misconfiguration must be loud).
   * `'disabled'` is the explicit opt-out for routing/CORS-focused tests.
   */
  auth?: AssistantServerAuth;
  embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
  envFileFailures?: readonly DesktopEnvLoadFailure[];
  host?: string;
  listen?: boolean;
  llmHostManager?: AssistantLlmHostManager | null | undefined;
  openRouterModelMetadataService?: OpenRouterModelMetadataService;
}
