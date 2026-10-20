import { fault } from '@brainstrike/assistant-contract/boundary-failure';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostProcess, waitForAppHost, withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { installWorkspaceAckGate } from './utils/thread-workspace-ack-gate';

async function reloadFromMenu(app: ElectronApplication, page: Page): Promise<void> {
  const id = await (await app.browserWindow(page)).evaluate((window) => window.id);
  await app.evaluate(({ BrowserWindow, Menu }, windowId) => {
    const target = BrowserWindow.fromId(windowId);
    const item = Menu.getApplicationMenu()
      ?.items.find(({ label }) => label === 'View')
      ?.submenu?.items.find(({ label }) => label === 'Reload');
    if (!(target && item)) {
      throw new Error('The actual app Reload menu target is unavailable');
    }
    item.click(undefined, target, target.webContents);
  }, id);
}

for (const entry of ['menu', 'failed-chunk UI']) {
  for (const acknowledgement of ['held', 'acknowledged']) {
    const held = acknowledgement === 'held';
    test(`${entry} reload joins ${acknowledgement} workspace ACK and the fresh frame saves`, async ({
      electron,
      electronApp,
      modelProvider,
      window: page,
    }) => {
      const failures: string[] = [];
      page.on('console', (message) => {
        if (
          message.text().includes('ThreadWorkspaceCoordinator') &&
          message.text().includes('Failed to persist')
        ) {
          failures.push(message.text());
        }
      });
      await configureAssistantProvider(page);
      await page.addInitScript(installWorkspaceAckGate, {
        failHydration: false,
        failure: fault({
          category: 'availability',
          code: 'test.unused-reload-read',
          message: 'Unused hydration failure',
        }),
      });
      const { reloadRenderer } = await loadElectronHelpers();
      await reloadRenderer(page, 'install-workspace-reload-gate');
      await ensureAssistantShellVisible(page);
      await waitForAppHost(page);
      const hostBefore = await readHostProcess(electron.getUserDataDir());
      await page.evaluate(() => {
        const gate = window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__;
        if (!gate) {
          throw new Error('The committed ACK gate is unavailable');
        }
        gate.arm();
      });
      await page.getByTestId('assistant-new-thread-button').click();
      await page.waitForFunction(() => window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__?.heldWrites === 1);
      const expected = await page.evaluate(() => {
        const gate = window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__;
        const bridge = (
          window as Window & {
            agentHost?: { onPrepareClose(callback: () => Promise<void>): () => void };
          }
        ).agentHost;
        if (!(gate?.threadId && gate.snapshot && bridge)) {
          throw new Error('No admitted workspace response was held');
        }
        bridge.onPrepareClose(async () => {
          gate.closeRequested = true;
          console.info('workspace-reload-preparation-received');
        });
        return {
          snapshot: gate.snapshot,
          threadId: gate.threadId,
          timeOrigin: performance.timeOrigin,
        };
      });
      const before = await withAppHost(electron.getUserDataDir(), (client) =>
        client.request('thread/workspace/read', { threadId: expected.threadId })
      );
      expect(before.snapshot).toEqual(expected.snapshot);
      if (!held) {
        await page.evaluate(() => window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__?.release());
      }
      const first = Promise.withResolvers<'prepare' | 'navigate'>();
      let navigated = false;
      const onConsole = (message: { text(): string }) => {
        if (message.text() === 'workspace-reload-preparation-received') {
          first.resolve('prepare');
        }
      };
      const onNavigation = (frame: import('@playwright/test').Frame) => {
        if (frame === page.mainFrame()) {
          navigated = true;
          first.resolve('navigate');
        }
      };
      page.on('console', onConsole);
      page.on('framenavigated', onNavigation);
      const navigation = page.waitForEvent('framenavigated', {
        predicate: (frame) => frame === page.mainFrame(),
      });
      try {
        if (entry === 'menu') {
          await reloadFromMenu(electronApp.app, page);
        } else {
          // Simulate the external Vite chunk failure; click the real recovery UI.
          await page.evaluate(() => {
            window.dispatchEvent(
              Object.assign(new Event('vite:preloadError'), {
                payload: new Error('Isolated chunk load failure'),
              })
            );
          });
          await page.getByRole('button', { exact: true, name: 'Reload app' }).click();
        }
        if (held) {
          expect(await first.promise).toBe('prepare');
          expect(navigated).toBe(false);
          expect(
            await page.evaluate(() => ({
              closedDuringHold: window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__?.closedDuringHold,
              heldWrites: window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__?.heldWrites,
            }))
          ).toEqual({ closedDuringHold: false, heldWrites: 1 });
        }
      } finally {
        page.off('console', onConsole);
        page.off('framenavigated', onNavigation);
        if (!(navigated || page.isClosed())) {
          await page.evaluate(() => window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__?.release());
        }
        await navigation;
      }
      await ensureAssistantShellVisible(page);
      await waitForAppHost(page);
      expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(expected.timeOrigin);
      expect(await readHostProcess(electron.getUserDataDir())).toEqual(hostBefore);
      const after = await withAppHost(electron.getUserDataDir(), (client) =>
        client.request('thread/workspace/read', { threadId: expected.threadId })
      );
      expect(after.snapshot).toEqual(expected.snapshot);
      // This document must register new producers and commit a fresh thread snapshot.
      await page.evaluate(() => window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__?.arm());
      await page.getByTestId('assistant-new-thread-button').click();
      await page.waitForFunction(() => window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__?.heldWrites === 1);
      const fresh = await page.evaluate(() => {
        const gate = window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__;
        if (!(gate?.threadId && gate.snapshot)) {
          throw new Error('The replacement frame could not save');
        }
        gate.release();
        return { snapshot: gate.snapshot, threadId: gate.threadId };
      });
      expect(fresh.threadId).not.toBe(expected.threadId);
      expect(
        (
          await withAppHost(electron.getUserDataDir(), (client) =>
            client.request('thread/workspace/read', { threadId: fresh.threadId })
          )
        ).snapshot
      ).toEqual(fresh.snapshot);
      expect(failures).toEqual([]);
      expect(modelProvider.refusals()).toEqual([]);
    });
  }
}
