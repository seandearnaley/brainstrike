import type { Page } from '@playwright/test';

export interface FileTree {
  [key: string]: FileTree | null | string;
}

interface Options {
  clipboard?: boolean;
  directoryReadDelayMs?: number;
}

interface MockBrowserApisPayload {
  directoryReadDelayMs: number;
  enableClipboard: boolean;
  rootName: string;
  tree: FileTree;
}

function buildMockBrowserApisScript(payload: MockBrowserApisPayload): string {
  const serializedPayload = JSON.stringify(payload);
  return `
(() => {
  const payload = ${serializedPayload};
  window.__brainstrike_e2e_expose_file_explorer_store__ = true;
  const fixture = {
    name: payload.rootName,
    tree: payload.tree,
  };
  const fixtureOptions = payload.directoryReadDelayMs > 0
    ? { directoryReadDelayMs: payload.directoryReadDelayMs }
    : undefined;

  const waitForFixtureLoader = () => new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      const loadFixture = window.__BRAINSTRIKE_LOAD_FIXTURE__;
      if (typeof loadFixture === 'function') {
        resolve(loadFixture);
        return;
      }
      if (attempts++ > 200) {
        reject(new Error('Fixture testing API was not exposed in time'));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });

  window.showDirectoryPicker = async () => {
    const loadFixture = await waitForFixtureLoader();
    const handle = await loadFixture(fixture, fixtureOptions);
    if (!handle) {
      throw new Error('Fixture testing API did not return a directory handle');
    }
    return handle;
  };

  if (payload.enableClipboard) {
    if (navigator.clipboard) {
      const originalWriteText = navigator.clipboard.writeText;
      navigator.clipboard.writeText = async (text) => {
        // Always log so tests can assert the written text via console messages,
        // even when the real clipboard API succeeds headlessly.
        console.log('Clipboard mock: writeText called with:', text);
        try {
          return await originalWriteText.call(navigator.clipboard, text);
        } catch {
          console.log('Clipboard fallback: writeText called with:', text);
          return Promise.resolve();
        }
      };
    } else {
      navigator.clipboard = {
        writeText: async (text) => {
          console.log('Clipboard mock: writeText called with:', text);
          return Promise.resolve();
        },
      };
    }
  }
})();
`;
}

export async function mockBrowserApis(
  page: Page,
  rootName: string,
  tree: FileTree,
  options: Options = {}
): Promise<void> {
  const payload: MockBrowserApisPayload = {
    directoryReadDelayMs: options.directoryReadDelayMs ?? 0,
    enableClipboard: options.clipboard ?? false,
    rootName,
    tree,
  };
  await page.addInitScript(buildMockBrowserApisScript(payload));
}

/**
 * Multi-root harness: add an ADDITIONAL mock root to the workspace after the
 * primary fixture is active (i.e. after selectRoot()). Routes through
 * __BRAINSTRIKE_ADD_FIXTURE_ROOT__, which appends both the adapter fixture
 * state and the workspace root (never persisted) — the seam that finally
 * lets web e2e exercise forest (multi-root) flows.
 */
export async function addMockRoot(page: Page, rootName: string, tree: FileTree): Promise<void> {
  await page.evaluate(
    async ({ rootName: name, tree: fixtureTree }) => {
      const addFixtureRootKey = '__BRAINSTRIKE_ADD_FIXTURE_ROOT__';
      const browserWindow = window as Window & {
        [addFixtureRootKey]?: (fixture: {
          name: string;
          tree: FileTree;
        }) => Promise<unknown> | unknown;
      };
      const addFixtureRoot = browserWindow[addFixtureRootKey];
      if (typeof addFixtureRoot !== 'function') {
        throw new Error('Multi-root fixture API was not exposed — load the primary fixture first');
      }
      await addFixtureRoot({ name, tree: fixtureTree });
    },
    { rootName, tree }
  );
}
