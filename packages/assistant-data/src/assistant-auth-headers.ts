import {
  ASSISTANT_AUTH_HEADER_NAME,
  type AssistantBridge,
  getAssistantBridge,
} from '@brainstrike/assistant-contract';

export type AssistantAuthBridge = Pick<AssistantBridge, 'getAuth'>;

/**
 * Resolves the auth headers every assistant-server request must carry. The
 * desktop bridge's `getAuth` supplies the per-boot token (see
 * `ASSISTANT_AUTH_HEADER_NAME` in @brainstrike/assistant-contract); web builds
 * have no bridge and get an empty object (same-origin `/api` needs none).
 */
export async function resolveAssistantAuthHeaders(): Promise<Record<string, string>> {
  if (typeof window === 'undefined') {
    return {};
  }

  const bridge = getAssistantBridge();
  if (bridge && typeof bridge.getAuth === 'function') {
    try {
      const auth = await bridge.getAuth();
      if (auth && 'token' in auth && auth.token) {
        return { [ASSISTANT_AUTH_HEADER_NAME]: auth.token };
      }
    } catch {
      // The request proceeds without the header so the server's 401 surfaces
      // the failure instead of substituting a client-side credential guess.
    }
  }

  return {};
}
