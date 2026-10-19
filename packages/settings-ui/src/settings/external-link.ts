import type { MouseEvent } from 'react';

/**
 * Desktop denies renderer navigation to external origins, so a link click routes
 * through the `window.platform.openExternal` bridge when it exists; without that
 * bridge (web) the native anchor navigation does the job.
 */
type OpenExternal = (target: string) => Promise<{ error?: string; ok: boolean }>;

/** Resolves to why the link did not open, or `undefined` when it opened (or the anchor navigates). */
export async function openExternalLink(
  event: MouseEvent<HTMLAnchorElement>,
  url: string
): Promise<string | undefined> {
  const platform = (window as unknown as { platform?: { openExternal?: unknown } }).platform;
  const openExternal = platform?.openExternal;
  if (typeof openExternal !== 'function') {
    return undefined;
  }
  // Synchronous, before the first await: the click's default navigation is cancelled.
  event.preventDefault();
  try {
    const result = await (openExternal as OpenExternal)(url);
    return result.ok ? undefined : (result.error ?? 'The link could not be opened.');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
