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
