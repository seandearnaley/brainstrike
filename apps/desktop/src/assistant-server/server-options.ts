// Deliberately separate from the service package's types floor
// (@brainstrike/assistant-service/types): the options interface type-depends
// on five siblings, and housing it here keeps the shared types floor a true
// leaf — nobody importing @brainstrike/assistant-service/types inherits
// these edges, and no silent
// invariant ("everyone remembers import type") is required (#2111 review).

import type { DeprecatedEnvVarReport } from '@brainstrike/assistant-contract/provider-metadata';
import type { AssistantLlmHostManager } from '@brainstrike/assistant-service/ports';
import type { DesktopEnvLoadFailure } from '../desktop-env';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import type { AssistantServerAuth } from './auth';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';
import type { ForgeService } from './forge-service';
import type { OpenRouterModelMetadataService } from './openrouter-model-metadata';
import type { ProviderVerificationService } from './provider-verification';
import type { SnapshotRepository } from './snapshot-repository';
import type { SnapshotService } from './snapshot-service';
import type { WorktreeService } from './worktree-service';

/**
 * Shadow-git snapshot deps for the run-persistence seam (BST-1164 W7 T1).
 * `service` is the ONE app-lifetime SnapshotService main.ts constructs at
 * app-ready; `createRepository` binds the snapshot ledger rows to whatever DB
 * handle the consumer already resolves. Threaded through
 * {@link AssistantServerOptions}; consumed by T2's turn-boundary triggers in
 * `assistant-server.ts` (`snapshot-turn-boundaries.ts`) — main.ts never
 * needed editing. Consumers must never construct a second SnapshotService.
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
  /**
   * Deprecated provider env vars detected by desktop MAIN from its own
   * process environment at startup (BST-1361) — never computed from the
   * wire. Surfaced verbatim on the `/assistant/status` payload so the
   * renderer can render rename guidance (UI arrives with BST-1362).
   */
  deprecatedEnvVars?: readonly DeprecatedEnvVarReport[];
  embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
  envFileFailures?: readonly DesktopEnvLoadFailure[];
  host?: string;
  listen?: boolean;
  llmHostManager?: AssistantLlmHostManager | null | undefined;
  openRouterModelMetadataService?: OpenRouterModelMetadataService;
  /** BST-1357 credential-verification probes; module-level default when unset. */
  providerVerificationService?: ProviderVerificationService;
  /**
   * Lazily resolved because `main.ts` constructs the ForgeService at
   * `app.whenReady()` while the assistant server starts from the same phase.
   */
  resolveForgeService?: (() => ForgeService | null) | undefined;
  /**
   * Lazily resolved because `main.ts` constructs the WorktreeService at
   * `app.whenReady()` while the assistant server starts from the same phase —
   * the same laziness `worktrees-ipc-handlers.ts` uses for its `resolveService`.
   */
  resolveWorktreeService?: (() => WorktreeService | null) | undefined;
  /** See {@link DesktopWorkspaceSnapshotDependencies} — T1 injection point. */
  snapshots?: DesktopWorkspaceSnapshotDependencies | null | undefined;
}
