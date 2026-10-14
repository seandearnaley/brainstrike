import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { foldHostRuns } from '@brainstrike/agent-host/thread-view';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { runInteractiveChildFixture } from './utils/interactive-child-fixture';
import {
  ensureActivityExpanded,
  ensureAssistantShellVisible,
  ensureMockWorkspaceOpen,
} from './utils/layout-helpers';
import {
  assembledMarkers,
  createAssembledSubagentFixture,
} from './utils/subagent-integration-fixture';

/** Each child as the agent host commits it: its call sign, delegated task and latest run status. */
async function readHostChildren(userDataDir: string) {
  return (await readHostThreadTree(userDataDir)).flatMap(({ child, rows }) => {
    if (!child) {
      return [];
    }
    const started = rows.find(({ event }) => event.type === 'run.started')?.event;
    return [
      {
        displayName: child.callSign,
        taskPrompt: started?.type === 'run.started' ? started.prompt : undefined,
        taskStatus: foldHostRuns(rows).at(-1)?.status ?? 'running',
      },
    ];
  });
}

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
      await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
      await new HomePage(window).openSettings();
      const settings = new SettingsPage(window);
      await settings.openCategory(/Permissions/i, 'permissions');
      await window
        .getByRole('combobox', { exact: true, name: 'Read permission' })
        .selectOption('ask');
      await settings.setSubagentLimit('Subagent work at once', 'maxConcurrentWork', 2);
      await ensureAssistantShellVisible(window);
      // The host thread's conversation is the Assistant region; it has no legacy panel test id.
      const root = window.getByRole('region', { exact: true, name: 'Assistant' });
      await root
        .getByRole('textbox', { name: 'Message input' })
        .fill(assembledMarkers.parentPrompt);
      await root.getByRole('button', { exact: true, name: 'Send' }).click();
      // The shared provider fixture holds stream dispatch until both parked
      // children release their work permits by requesting approval.
      await expect
        .poll(
          async () =>
            (await readHostThreadTree(electron.getUserDataDir())).filter(
              ({ parentThreadId, rows }) =>
                parentThreadId !== undefined &&
                rows.some(({ event }) => event.type === 'interaction.requested')
            ).length
        )
        .toBe(2);
      fixture.releaseStreams();
      await expect(root.getByText('ASSEMBLED_ROOT_CONTINUES_1770', { exact: true })).toBeVisible();

      // A run's delegations share its activity group; each persona has its own card.
      const selectedTab = window
        .getByRole('tablist', { name: 'Workspace tabs' })
        .getByRole('tab', { selected: true });
      const openChild = async (persona: string): Promise<string> => {
        const card = window.getByTestId('subagent-execution-card').filter({ hasText: persona });
        await ensureActivityExpanded(
          root.getByTestId('assistant-activity-group').filter({ has: card })
        );
        await root
          .getByTestId('subagent-execution-card')
          .filter({ hasText: persona })
          .getByRole('button', { name: /Open .* conversation/ })
          .click();
        await expect(selectedTab).toHaveText(/^[A-Z][a-z]+-[a-f0-9]{6}$/u);
        return (await selectedTab.innerText()).trim();
      };
      const granted = await openChild('parked-grant');
      const grant = window.getByRole('region', { exact: true, name: granted }).getByRole('button', {
        exact: true,
        name: 'Allow reads this session brainstrike.readWorkspaceFile',
      });
      await expect(grant).toBeVisible();
      await grant.click();
      await expect
        .poll(
          async () =>
            (await readHostChildren(electron.getUserDataDir())).filter(
              (child) => child.taskStatus === 'running'
            ).length
        )
        .toBe(4);

      // Open three tabs while two provider streams remain held. The other
      // children are also running, waiting for the shared work permits.
      await openChild('stream-alpha');
      await openChild('stream-beta');
      const tabs = window.getByRole('tablist', { name: 'Workspace tabs' });
      const childTabs = tabs.getByRole('tab', {
        name: /^[A-Z][a-z]+-[a-f0-9]{6}$/u,
      });
      await expect(childTabs).toHaveCount(3);

      const timings: number[] = [];
      for (const index of [0, 1, 2, 0, 2]) {
        const tab = childTabs.nth(index);
        const name = (await tab.innerText()).trim();
        await tab.evaluate((element) => {
          const measured = element as HTMLElement & {
            switchMeasurement?: {
              durationMs?: number;
              cleanup: () => void;
            };
          };
          const controller = new AbortController();
          let observer: MutationObserver | undefined;
          let frame: number | undefined;
          let nextFrame: number | undefined;
          const cleanup = () => {
            controller.abort();
            observer?.disconnect();
            if (frame !== undefined) {
              cancelAnimationFrame(frame);
            }
            if (nextFrame !== undefined) {
              cancelAnimationFrame(nextFrame);
            }
          };
          const measurement: { durationMs?: number; cleanup: () => void } = { cleanup };
          measured.switchMeasurement = measurement;
          element.addEventListener(
            'pointerdown',
            () => {
              const start = performance.now();
              observer = new MutationObserver(() => {
                if (element.getAttribute('aria-selected') !== 'true') {
                  return;
                }
                observer?.disconnect();
                frame = requestAnimationFrame(() => {
                  nextFrame = requestAnimationFrame(() => {
                    measurement.durationMs = performance.now() - start;
                  });
                });
              });
              observer.observe(element, {
                attributeFilter: ['aria-selected'],
                attributes: true,
              });
            },
            { once: true, signal: controller.signal }
          );
        });
        try {
          await tab.click();
          await expect(tab).toHaveAttribute('aria-selected', 'true');
          await expect(window.getByRole('region', { exact: true, name })).toBeVisible();
          await expect
            .poll(() =>
              tab.evaluate(
                (element) =>
                  (element as HTMLElement & { switchMeasurement?: { durationMs?: number } })
                    .switchMeasurement?.durationMs
              )
            )
            .toBeGreaterThanOrEqual(0);
          const duration = await tab.evaluate(
            (element) =>
              (element as HTMLElement & { switchMeasurement: { durationMs: number } })
                .switchMeasurement.durationMs
          );
          timings.push(duration);
          // One child conversation is visible; the others stay mounted, hidden.
          await expect(
            window.getByRole('region', { name: /^[A-Z][a-z]+-[a-f0-9]{6}$/u })
          ).toHaveCount(1);
        } finally {
          await tab.evaluate((element) => {
            const measured = element as HTMLElement & {
              switchMeasurement?: { cleanup: () => void };
            };
            measured.switchMeasurement?.cleanup();
            measured.switchMeasurement = undefined;
          });
        }
      }
      await testInfo.attach('child-tab-switch-ms', {
        body: JSON.stringify(timings),
        contentType: 'application/json',
      });
      console.log('CHILD_TAB_SWITCH_MS', JSON.stringify(timings));
      // Output produced while another tab is active appears on return.
      const alpha = (await readHostChildren(electron.getUserDataDir())).find(
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
            (await readHostChildren(electron.getUserDataDir())).find(
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
