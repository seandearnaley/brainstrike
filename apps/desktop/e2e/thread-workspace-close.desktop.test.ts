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
 * committed, after a relaunch: the agent host for the thread workspace, Main's storage for
 * Explorer persistence.
 */
test('@smoke app-owned quit commits a still-buffered workspace edit and the reopened app reads it', async ({
  electron,
  window: page,
}) => {
  const fixture = await openDurableUiFixture(electron, page);
  const userDataDir = electron.getUserDataDir();
  try {
    // Both writers still buffer this edit when quit starts (500 ms and 100 ms).
    await expandFixtureFolder(page);
    await electron.closeForStateSeeding();
    expect(await readStoredExplorerExpansion(userDataDir)).toContain(fixture.expandedPath);

    const reopened = await electron.ensureWindow({ preserveState: true });
    await ensureAssistantShellVisible(reopened);
    await waitForAppHost(reopened);
    expect(await readCommittedThreadExpansion(userDataDir, fixture.threadId)).toContain(
      fixture.expandedPath
    );
  } finally {
    await fixture.dispose();
  }
});
