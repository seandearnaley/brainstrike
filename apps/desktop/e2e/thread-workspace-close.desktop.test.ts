import { expect, test } from './fixtures/electron-fixture';
import { waitForAppHost } from './utils/agent-host-log';
import {
  expandFixtureFolder,
  openDurableUiFixture,
  readCommittedThreadExpansion,
  readStoredExplorerExpansion,
} from './utils/durable-ui-state';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

/**
 * ADR-0026 R1: the last write is committed before the document unloads. Read where it is
 * committed, after a relaunch: the agent host for the thread workspace, the renderer's
 * `localStorage` for Explorer persistence.
 */
test('@smoke app-owned quit commits a still-buffered workspace edit and the reopened app reads it', async ({
  electron,
  window,
}) => {
  const fixture = await openDurableUiFixture(electron, window);
  const userDataDir = electron.getUserDataDir();
  // The thread workspace writer still buffers this edit when quit starts (500 ms).
  await expandFixtureFolder(fixture.page);
  await electron.closeForStateSeeding();

  const reopened = await electron.ensureWindow({ preserveState: true });
  expect(await readStoredExplorerExpansion(reopened)).toContain(fixture.expandedPath);
  await ensureAssistantShellVisible(reopened);
  await waitForAppHost(reopened);
  expect(await readCommittedThreadExpansion(userDataDir, fixture.threadId)).toContain(
    fixture.expandedPath
  );
});
