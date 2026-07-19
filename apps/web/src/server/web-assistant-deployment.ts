export const WEB_ASSISTANT_PRODUCTION_DISABLED_REASON = 'production_auth_required';

export type WebAssistantDeploymentAccess =
  | { readonly enabled: true }
  | {
      readonly enabled: false;
      readonly reason: typeof WEB_ASSISTANT_PRODUCTION_DISABLED_REASON;
    };

/**
 * The server-key endpoint is intentionally limited to Vercel previews, where
 * the project deployment-protection policy is the authentication boundary.
 * Production needs application authentication plus distributed quota/cost
 * controls before it may spend a server credential.
 */
export function resolveWebAssistantDeploymentAccess(
  vercelEnvironment: string | undefined
): WebAssistantDeploymentAccess {
  if (vercelEnvironment === 'preview') {
    return { enabled: true };
  }
  return {
    enabled: false,
    reason: WEB_ASSISTANT_PRODUCTION_DISABLED_REASON,
  };
}
