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
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';
import type { OpenRouterModelMetadataService } from './openrouter-model-metadata';
import type { SnapshotRepository } from './snapshot-repository';
import type { SnapshotService } from './snapshot-service';

/**
 * Shadow-git snapshot deps for the run-persistence seam (BST-1164 W7 T1).
 * `service` is the ONE app-lifetime SnapshotService main.ts constructs at
 * app-ready; `createRepository` binds the snapshot ledger rows to whatever DB
 * handle the consumer already resolves. Threaded through
 * {@link AssistantServerOptions} and NOT read anywhere yet — T2's
 * turn-boundary triggers consume it so T2 never edits main.ts. Consumers must
 * never construct a second SnapshotService.
 */
export interface DesktopWorkspaceSnapshotDependencies {
  readonly createRepository: (db: EditCheckpointDatabase) => SnapshotRepository;
  readonly service: SnapshotService;
}

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
  /** See {@link DesktopWorkspaceSnapshotDependencies} — T1 injection point. */
  snapshots?: DesktopWorkspaceSnapshotDependencies | null | undefined;
}
