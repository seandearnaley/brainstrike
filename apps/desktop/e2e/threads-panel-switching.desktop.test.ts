import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderRequest, ModelProviderScript } from './utils/model-provider-shim';

const destinations = ['Artifacts', 'Settings'] as const;
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

// Two animation frames: the ResizeObserver notifications for the previous
// layout change are delivered in the first frame's rendering step, before the
// second frame's callbacks run.
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

// What the user sees: the scroll position and the rows inside the viewport
// (below a sticky header, if any). Overscan rows outside it are not visible.
// A virtualizer spacer (a blank `tr` standing in for unrendered rows) inside
// the viewport is a blank band the user would see: the rendered window does
// not yet match the scroll position.
async function readVisibleGeometry(viewport: Locator) {
  return await viewport.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const header = element.querySelector('thead');
    const top = header ? Math.max(0, header.getBoundingClientRect().bottom - box.top) : 0;
    const bottom = element.clientHeight;
    const place = (row: Element) => {
      const rect = row.getBoundingClientRect();
      return { height: rect.height, offset: rect.top - box.top };
    };
    const inView = ({ height, offset }: { height: number; offset: number }) =>
      height > 0 && offset + height > top && offset < bottom;
    const rows = [...element.querySelectorAll('tbody tr[data-node-id]')]
      .map((row) => ({
        depth: row.getAttribute('data-depth'),
        expanded: row.getAttribute('aria-expanded'),
        id: row.getAttribute('data-node-id'),
        ...place(row),
      }))
      .filter(inView);
    const blankSpacersInView = [...element.querySelectorAll('tbody tr:not([data-node-id])')]
      .map(place)
      .filter(inView);
    return {
      blankSpacersInView,
      geometry: {
        height: element.clientHeight,
        rows,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      },
    };
  });
}

async function visibleGeometry(page: Page, viewport: Locator) {
  await nextFrames(page);
  await expect
    .poll(async () => (await readVisibleGeometry(viewport)).blankSpacersInView, {
      message: 'Threads rows fill the viewport',
    })
    .toEqual([]);
  return (await readVisibleGeometry(viewport)).geometry;
}

// Literal variants, so the static lane-coverage guard can read each title (BST-2026).
for (const variant of ['plain list', 'expanded descendants'] as const) {
  const expanded = variant === 'expanded descendants';
  test(`preserves Threads across every ribbon app (${variant})`, async ({
    window: page,
    electron,
    electronApp,
    modelProvider,
  }, testInfo) => {
    await electronApp.app.evaluate(({ app }) => app.setPath('documents', app.getPath('userData')));
    await ensureAssistantShellVisible(page);
    const panel = page.getByTestId('threads-panel');
    await expect(panel.getByTestId('thread-row')).toHaveCount(1);
    for (let index = 0; index < 44; index++) {
      await page.getByRole('button', { exact: true, name: 'New thread' }).click();
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
    for (const destination of destinations) {
      for (const top of [0, 240, 'bottom'] as const) {
        await test.step(`${destination} at scrollTop=${top}`, async () => {
          const target =
            top === 'bottom'
              ? await viewport.evaluate((element) => element.scrollHeight - element.clientHeight)
              : top;
          await viewport.evaluate((element, offset) => {
            element.scrollTop = offset;
          }, target);
          const before = await visibleGeometry(page, viewport);
          expect(before.scrollTop).toBe(target);
          await page.getByRole('button', { exact: true, name: destination }).click();
          await expect(panel).toBeHidden();
          await nextFrames(page);
          await page.getByRole('button', { exact: true, name: 'Context Explorer' }).click();
          await expect(panel).toBeVisible();
          const after = await visibleGeometry(page, viewport);
          results.push({ after, before, destination, expanded, top });
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
