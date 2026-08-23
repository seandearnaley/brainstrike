/**
 * Auth contract between the desktop assistant HTTP server and its renderer
 * clients. The desktop main process mints a per-boot capability token and hands
 * it to the renderer over the `assistant:get-auth` IPC bridge; every HTTP
 * request to the assistant server must carry it in this header. Web builds
 * have no bridge and no local assistant server, so they never send it.
 */
export const ASSISTANT_AUTH_HEADER_NAME = 'x-brainstrike-assistant-token';

/** Shape returned by the desktop `assistant:get-auth` IPC channel. */
export interface AssistantServerAuthInfo {
  token: string;
  url: string;
}

/**
 * The assistant server failed to start (BST-574). Returned by
 * `assistant:get-auth` instead of `null` so the renderer can present the
 * concrete failure rather than an indistinguishable "still starting" state.
 */
export interface AssistantServerStartupFailure {
  startupError: string;
}

/** Full result union of the `assistant:get-auth` channel; `null` = starting. */
export type AssistantServerAuthResult =
  | AssistantServerAuthInfo
  | AssistantServerStartupFailure
  | null;

/** Desktop preload capability for the embedded assistant server. Absent on web. */
export interface AssistantBridge {
  getAuth?: () => Promise<AssistantServerAuthResult>;
  getUrl?: () => Promise<string>;
  url?: string;
}

declare global {
  interface Window {
    assistant?: AssistantBridge;
  }
}

/**
 * Read the optional desktop assistant capability without making consumers
 * repeat unverified casts. The bridge remains capability-gated: web and SSR
 * return undefined rather than receiving a stub.
 */
export function getAssistantBridge(): AssistantBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.assistant;
}
