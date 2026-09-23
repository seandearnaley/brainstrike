import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { runInteractiveChildFixture } from './utils/interactive-child-fixture';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import {
  assembledMarkers,
  createAssembledSubagentFixture,
  readAssembledPersistence,
} from './utils/subagent-integration-fixture';

test('switches among running child tabs and retains the child draft', async ({
  electron,
}, testInfo) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-child-tab-response-'));
  const fixture = await createAssembledSubagentFixture(workspace);
  await runInteractiveChildFixture({
    captureFailure: async (window) => {
      await testInfo.attach('child-tab-response-failure', {
        body: await window.locator('body').innerText(),
        contentType: 'text/plain',
      });
    },
    closeProvider: async () => {
      fixture.releaseAlpha();
      fixture.releaseBeta();
      await fixture.provider.close();
    },
    electron,
    environment: fixture.environment,
    run: async (window) => {
      await ensureMockWorkspaceOpen(window);
      await configureAssistantProvider(window, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await new HomePage(window).openSettings();
      const settings = new SettingsPage(window);
      await settings.openCategory(/Permissions/i, 'permissions');
      await window
        .getByRole('combobox', { exact: true, name: 'Read permission' })
        .selectOption('ask');
      await settings.setSubagentLimit('Subagent work at once', 'maxConcurrentWork', 2);
      await ensureAssistantShellVisible(window);
      const root = window.getByTestId('chat-panel');
      await root
        .getByRole('textbox', { name: 'Message input' })
        .fill(assembledMarkers.parentPrompt);
      await root.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(root.getByText('ASSEMBLED_ROOT_CONTINUES_1770', { exact: true })).toBeVisible();

      const activity = root.getByTestId('assistant-activity-group').last();
      await activity.getByRole('button', { exact: true, name: 'Expand activity' }).click();
      const openButtons = activity.getByRole('button', { name: /Open .* conversation/ });
      await expect(openButtons).toHaveCount(4);
      await openButtons.nth(0).click();
      const grant = window
        .getByTestId('assistant-conversation-panel')
        .getByTestId('approval-grant-category-session');
      await expect(grant).toBeVisible();
      await grant.click();
      await expect
        .poll(
          async () =>
            (await readAssembledPersistence(window)).children.filter(
              (child) => child.taskStatus === 'running'
            ).length
        )
        .toBe(4);

      // Open three tabs while two provider streams remain held. The other
      // children are also running, waiting for the shared work permits.
      await openButtons.nth(2).click();
      await openButtons.nth(3).click();
      const tabs = window.getByRole('tablist', { name: 'Workspace tabs' });
      const childTabs = tabs.getByRole('tab', {
        name: /^(Cedar|Fern|Aspen|Maple|Iris|Willow)-[a-f0-9]+$/u,
      });
      await expect(childTabs).toHaveCount(3);

      const timings: number[] = [];
      for (const index of [0, 1, 2, 0, 2]) {
        const tab = childTabs.nth(index);
        const name = (await tab.innerText()).trim();
        const painted = tab.evaluate(
          (element) =>
            new Promise<number>((resolve, reject) => {
              const timeout = globalThis.setTimeout(
                () => reject(new Error('Child tab did not paint')),
                5000
              );
              element.addEventListener(
                'pointerdown',
                () => {
                  const start = performance.now();
                  const observer = new MutationObserver(() => {
                    if (element.getAttribute('aria-selected') !== 'true') {
                      return;
                    }
                    observer.disconnect();
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => {
                        globalThis.clearTimeout(timeout);
                        resolve(performance.now() - start);
                      })
                    );
                  });
                  observer.observe(element, {
                    attributeFilter: ['aria-selected'],
                    attributes: true,
                  });
                },
                { once: true }
              );
            })
        );
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(window.getByRole('region', { exact: true, name })).toBeVisible();
        timings.push(await painted);
        await expect(
          window.locator('[data-testid="assistant-conversation-panel"]:visible')
        ).toHaveCount(1);
      }
      await testInfo.attach('child-tab-switch-ms', {
        body: JSON.stringify(timings),
        contentType: 'application/json',
      });
      console.log('CHILD_TAB_SWITCH_MS', JSON.stringify(timings));
      // Output produced while another tab is active appears on return.
      const alpha = (await readAssembledPersistence(window)).children.find(
        (child) => child.taskPrompt === 'STREAM_ALPHA_TASK_1770'
      );
      expect(alpha).toBeDefined();
      const alphaTab = tabs.getByRole('tab', { exact: true, name: alpha?.displayName });
      await alphaTab.click();
      const alphaPanel = window.getByRole('region', {
        exact: true,
        includeHidden: true,
        name: alpha?.displayName,
      });
      const draft = alphaPanel.getByRole('textbox', { name: 'Message input' });
      await draft.fill('UNSENT_CHILD_TAB_DRAFT');
      await childTabs.nth(0).click();
      fixture.releaseAlpha();
      await expect
        .poll(
          async () =>
            (await readAssembledPersistence(window)).children.find(
              (child) => child.taskPrompt === 'STREAM_ALPHA_TASK_1770'
            )?.taskStatus
        )
        .toBe('completed');
      await alphaTab.click();
      await expect(alphaPanel.getByText(assembledMarkers.streamA, { exact: true })).toBeVisible();
      await expect(draft).toHaveValue('UNSENT_CHILD_TAB_DRAFT');
    },
    workspace,
  });
});
