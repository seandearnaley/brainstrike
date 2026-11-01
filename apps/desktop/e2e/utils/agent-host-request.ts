import type { Page } from '@playwright/test';

/**
 * One request on the window's own agent host connection, through the renderer's test-mode hook.
 * The host decodes the method and its params, so a wrong one is refused there, visibly.
 */
export async function requestAgentHost(
  page: Page,
  method: string,
  params: unknown = {}
): Promise<unknown> {
  // The renderer installs its test hooks once it has mounted.
  await page.waitForFunction(() => '__brainstrikeTestHooks__' in globalThis);
  return await page.evaluate(
    async ({ method: name, params: input }) => {
      const hooks = (
        globalThis as typeof globalThis & {
          __brainstrikeTestHooks__?: {
            requestAgentHost?: (method: string, params: unknown) => Promise<unknown>;
          };
        }
      ).__brainstrikeTestHooks__;
      if (!hooks?.requestAgentHost) {
        throw new Error('The renderer test hook requestAgentHost is unavailable');
      }
      return await hooks.requestAgentHost(name, input);
    },
    { method, params }
  );
}

/** One open folder, as the host's root registry restores it. */
export interface RestoredWorkspaceFolder {
  readonly available: boolean;
  readonly path: string;
  readonly rootId: string;
}

/** The host's open folders, restored as the renderer restores them. */
export async function restoreWorkspaceFolders(
  page: Page
): Promise<readonly RestoredWorkspaceFolder[]> {
  const { roots } = (await requestAgentHost(page, 'workspace/roots/restore')) as {
    roots: readonly RestoredWorkspaceFolder[];
  };
  return roots;
}
