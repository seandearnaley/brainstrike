import { ASSISTANT_AUTH_HEADER_NAME } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';

export const assistantEndpointLogger = createLogger('AssistantEndpoint');

declare global {
  interface Window {
    assistant?: {
      getAuth?: () => Promise<{ token: string; url: string } | { startupError: string } | null>;
      getUrl?: () => Promise<string>;
      url?: string;
    };
  }
}

export interface AssistantEndpoint {
  api: string;
  /** Present only when the desktop bridge supplied a per-boot auth token. */
  headers?: Record<string, string>;
}

const toApiUrl = (base: string): string => `${base.replace(/\/+$/, '')}/assistant`;

/**
 * Resolves the assistant data-stream endpoint from the desktop bridge.
 * Prefers `getAuth` ({ url, token } — the token must accompany every request);
 * falls back to the token-less `getUrl` for older bridges, and to `undefined`
 * when no bridge exists (web builds keep their same-origin `/api` default).
 */
export async function resolveAssistantEndpoint(): Promise<AssistantEndpoint | undefined> {
  if (typeof window === 'undefined') {
    return;
  }
  const bridge = window.assistant;
  if (!bridge) {
    return;
  }

  if (typeof bridge.getAuth === 'function') {
    const auth = await bridge.getAuth();
    if (auth && 'startupError' in auth) {
      // Server failed to start: no endpoint exists. Surface loudly (the
      // availability probe presents the same failure as an error state) and
      // do NOT fall through to getUrl — it would return the same dead state.
      assistantEndpointLogger.error('Assistant server failed to start', {
        startupError: auth.startupError,
      });
      return;
    }
    if (auth) {
      return {
        api: toApiUrl(auth.url),
        headers: { [ASSISTANT_AUTH_HEADER_NAME]: auth.token },
      };
    }
  }

  if (typeof bridge.getUrl === 'function') {
    const url = await bridge.getUrl();
    if (url) {
      return { api: toApiUrl(url) };
    }
  }

  return;
}

/**
 * Per-request auth-header resolver for the data-stream runtime (its `headers`
 * option accepts an async function). Resolves the per-boot token from the
 * desktop bridge on every request; web builds (no bridge) get no extra
 * headers. A stable module-level function so it never churns runtime options.
 */
export async function resolveAssistantAuthHeaders(): Promise<Record<string, string>> {
  try {
    const endpoint = await resolveAssistantEndpoint();
    return endpoint?.headers ?? {};
  } catch (error) {
    // Mirror the app-shell resolver: proceed header-less so the server's 401
    // surfaces the failure loudly instead of failing the send client-side.
    assistantEndpointLogger.error('Failed to resolve assistant auth headers', { error });
    return {};
  }
}
