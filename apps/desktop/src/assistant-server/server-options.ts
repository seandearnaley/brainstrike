import type { DeprecatedEnvVarReport } from '@brainstrike/assistant-contract/provider-metadata';
import type { DesktopEnvLoadFailure } from '../desktop-env';
import type { AssistantServerAuth } from './auth';
import type { OpenRouterModelMetadataService } from './openrouter-model-metadata';
import type { ProviderVerificationService } from './provider-verification';

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
   * wire. Surfaced verbatim on the `/assistant/status` payload.
   */
  deprecatedEnvVars?: readonly DeprecatedEnvVarReport[];
  envFileFailures?: readonly DesktopEnvLoadFailure[];
  host?: string;
  listen?: boolean;
  openRouterModelMetadataService?: OpenRouterModelMetadataService;
  /** BST-1357 credential-verification probes; module-level default when unset. */
  providerVerificationService?: ProviderVerificationService;
}
