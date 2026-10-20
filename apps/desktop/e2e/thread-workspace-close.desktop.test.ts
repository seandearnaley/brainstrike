import { fault } from '@brainstrike/assistant-contract/boundary-failure';
import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import { Schema } from 'effect';
import { expect, test } from './fixtures/electron-fixture';
import { waitForAppHost, withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { installWorkspaceAckGate } from './utils/thread-workspace-ack-gate';

for (const branch of ['inherited', 'hydration-failure live edit'] as const) {
  test(`@smoke app-owned close joins the ${branch} workspace ACK and reopens its snapshot`, async ({
    electron,
    window: page,
  }) => {
    await configureAssistantProvider(page);
    await page.addInitScript(installWorkspaceAckGate, {
      failHydration: branch !== 'inherited',
      failure: fault({
        category: 'availability',
        code: 'test.expected-workspace-read-failure',
        message: 'Expected disposable workspace hydration failure',
      }),
    });
    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'workspace-close-ack-gate');
    await ensureAssistantShellVisible(page);
    const userData = electron.getUserDataDir();
    await page.evaluate(() => {
      const gate = window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__;
      if (!gate) {
        throw new Error('Workspace ACK gate was not installed');
      }
      gate.arm();
    });
    await page.getByTestId('assistant-new-thread-button').click();
    if (branch !== 'inherited') {
      await page.waitForFunction(
        () => window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__?.readHeld === true
      );
      await page
        .getByRole('navigation', { exact: true, name: 'Main navigation' })
        .getByRole('button', { exact: true, name: 'Settings' })
        .click();
      await expect(page.getByTestId('settings-route')).toBeVisible();
      await page.evaluate(() => {
        const gate = window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__;
        if (!gate) {
          throw new Error('Workspace ACK gate disappeared');
        }
        gate.failRead();
      });
    }
    await page.waitForFunction(() => window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__?.heldWrites === 1);
    const expected = await page.evaluate(() => {
      const gate = window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__;
      if (!(gate?.threadId && gate.snapshot)) {
        throw new Error('No admitted workspace write was observed');
      }
      const bridge = (
        window as Window & {
          agentHost?: { onPrepareClose(prepare: () => Promise<void>): () => void };
        }
      ).agentHost;
      if (!bridge) {
        throw new Error('App-owned close capability is unavailable');
      }
      bridge.onPrepareClose(async () => {
        gate.closeRequested = true;
      });
      return { snapshot: gate.snapshot, threadId: gate.threadId };
    });
    const snapshot = Schema.decodeUnknownSync(WorkspaceSnapshotSchema, {
      onExcessProperty: 'error',
    })(expected.snapshot);
    const closeSaveFailures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('ThreadWorkspaceCoordinator') && text.includes('Failed to persist')) {
        closeSaveFailures.push(text);
      }
    });
    let closed = false;
    const closing = electron.closeForStateSeeding().then(() => {
      closed = true;
    });
    try {
      await page.waitForFunction(
        () => window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__?.closeRequested === true
      );
      expect(closed).toBe(false);
      expect(page.isClosed()).toBe(false);
      expect(
        await page.evaluate(() => window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__?.closedDuringHold)
      ).toBe(false);
    } finally {
      if (!page.isClosed()) {
        await page.evaluate(() => {
          const gate = window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__;
          if (!gate) {
            throw new Error('The admitted workspace ACK gate disappeared before release');
          }
          gate.release();
        });
      }
      await closing;
    }
    expect(closeSaveFailures).toEqual([]);
    const reopened = await electron.ensureWindow({ preserveState: true });
    await ensureAssistantShellVisible(reopened);
    await waitForAppHost(reopened);
    const persisted = await withAppHost(userData, (client) =>
      client.request('thread/workspace/read', { threadId: expected.threadId })
    );
    expect(persisted.snapshot).toEqual(snapshot);
    await test.info().attach(`workspace-close-${branch}`, {
      body: JSON.stringify({ expected, persisted }),
      contentType: 'application/json',
    });
  });
}
