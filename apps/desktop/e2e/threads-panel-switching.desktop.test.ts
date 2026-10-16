import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderRequest, ModelProviderScript } from './utils/model-provider-shim';

const destinations = ['Notes', 'Git', 'Browser', 'Settings', 'Collections', 'Prompts'] as const;
const transitions = [
  ...destinations.map((destination) => ({ destination, via: undefined as string | undefined })),
  ...(['Collections', 'Prompts'] as const).flatMap((destination) =>
    ['Notes', 'Git', 'Browser', 'Settings'].map((via) => ({ destination, via }))
  ),
];
const CHILD_TASK = 'SWITCH_MATRIX_CHILD';
const GRAND_TASK = 'SWITCH_MATRIX_GRANDCHILD';

// Only the model boundary is scripted; the host creates and lists real descendants.
function delegation(request: ModelProviderRequest): ModelProviderScript {
  if (request.toolNames.length === 0) {
    return { finalText: 'Switch matrix parent' };
  }
  const task = JSON.stringify(
    request.messages.filter(
      (message) =>
        message && typeof message === 'object' && 'role' in message && message.role === 'user'
    )
  );
  if (task.includes(GRAND_TASK)) {
    return { finalText: 'GRANDCHILD_COMPLETE' };
  }
  if (task.includes(CHILD_TASK)) {
    return {
      finalText: 'CHILD_COMPLETE',
      toolCall: {
        arguments: { _background: { enabled: false }, prompt: GRAND_TASK },
        name: 'agent-worker',
      },
    };
  }
  return {
    finalText: 'SWITCH_MATRIX_READY',
    toolCall: {
      arguments: { _background: { enabled: false }, prompt: CHILD_TASK },
      name: 'agent-worker',
    },
  };
}

async function settle(page: Page): Promise<void> {
  // Include ResizeObserver delivery and the virtualizer's 150ms scroll-idle notification.
  await page.waitForTimeout(200);
}

async function geometry(viewport: Locator) {
  return await viewport.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      height: element.clientHeight,
      rows: [...element.querySelectorAll('tr[data-node-id]')].map((row) => ({
        depth: row.getAttribute('data-depth'),
        expanded: row.getAttribute('aria-expanded'),
        height: row.getBoundingClientRect().height,
        id: row.getAttribute('data-node-id'),
        offset: row.getBoundingClientRect().top - box.top,
      })),
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });
}

// Literal variants, so the static lane-coverage guard can read each title (BST-2026).
for (const variant of ['plain list', 'expanded descendants'] as const) {
  const expanded = variant === 'expanded descendants';
  test(`preserves Threads across every ribbon app and Library tab (${variant})`, async ({
    window: page,
    electron,
    electronApp,
    modelProvider,
  }, testInfo) => {
    await electronApp.app.evaluate(({ app }) => app.setPath('documents', app.getPath('userData')));
    await ensureAssistantShellVisible(page);
    await page.getByTestId('threads-tab-trigger').click();
    const panel = page.getByTestId('threads-panel');
    await expect(panel.getByTestId('thread-row')).toHaveCount(1);
    for (let index = 0; index < 44; index++) {
      await panel.getByRole('button', { exact: true, name: 'New thread' }).click();
    }
    if (expanded) {
      await ensureMockWorkspaceOpen(page);
      await configureAssistantProvider(page);
      modelProvider.setScript(delegation);
      const assistant = page.getByRole('region', { exact: true, name: 'Assistant' });
      await assistant
        .getByRole('textbox', { name: 'Message input' })
        .fill('Prepare the switch matrix');
      await assistant.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(assistant.getByText('SWITCH_MATRIX_READY', { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      const tree = await readHostThreadTree(electron.getUserDataDir());
      const child = tree.find((thread) =>
        thread.rows.some(
          (row) => row.event.type === 'run.started' && row.event.prompt === CHILD_TASK
        )
      );
      const grandchild = tree.find((thread) => thread.parentThreadId === child?.threadId);
      if (!(child?.child && child.parentThreadId && grandchild?.child)) {
        throw new Error('The real host did not commit the child and grandchild fixture');
      }
      await panel
        .locator(`tr[data-node-id="${child.parentThreadId}"]`)
        .getByRole('button', { exact: true, name: 'Expand' })
        .click();
      const childRow = panel
        .locator('tr[data-node-type="thread-panel-host-child"]')
        .filter({ hasText: child.child.callSign });
      await childRow.getByRole('button', { exact: true, name: 'Expand' }).click();
      await expect(
        panel
          .locator('tr[data-node-type="thread-panel-host-child"]')
          .filter({ hasText: grandchild.child.callSign })
      ).toBeVisible();
    }
    const viewport = panel.getByTestId('tree-table-viewport');
    const results: unknown[] = [];
    for (const { destination, via } of transitions) {
      for (const top of [0, 240, 'bottom'] as const) {
        await test.step(`${destination}${via ? ` via ${via}` : ''} at scrollTop=${top}`, async () => {
          const target =
            top === 'bottom'
              ? await viewport.evaluate((element) => element.scrollHeight - element.clientHeight)
              : top;
          await viewport.evaluate((element, offset) => {
            element.scrollTop = offset;
          }, target);
          await settle(page);
          const before = await geometry(viewport);
          expect(before.scrollTop).toBe(target);
          const library = destination === 'Collections' || destination === 'Prompts';
          await page
            .getByRole(library ? 'tab' : 'button', { exact: true, name: destination })
            .click();
          await expect(panel).toBeHidden();
          await settle(page);
          if (via) {
            await page.getByRole('button', { exact: true, name: via }).click();
            await expect(page.getByTestId('agent-sidebar-panel')).toBeHidden();
            await settle(page);
            await page.getByRole('button', { exact: true, name: 'Context Explorer' }).click();
            await expect(page.getByRole('tab', { exact: true, name: destination })).toHaveAttribute(
              'aria-selected',
              'true'
            );
            await settle(page);
          }
          await page
            .getByRole(library ? 'tab' : 'button', {
              exact: true,
              name: library ? 'Threads' : 'Context Explorer',
            })
            .click();
          await expect(panel).toBeVisible();
          await settle(page);
          const after = await geometry(viewport);
          results.push({ after, before, destination, expanded, top, via });
          expect
            .soft(after, `${destination}: return preserves rows, expansion and scroll`)
            .toEqual(before);
        });
      }
    }
    await testInfo.attach('switch-matrix', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
  });
}
