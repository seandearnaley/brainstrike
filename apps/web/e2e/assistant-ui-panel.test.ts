import { expect, type Page, test } from '@playwright/test';
import type { WebE2ETestHooks } from '../src/web-e2e-test-hooks';
import { HOSTED_ASSISTANT_STATUS, mockAssistantApi } from './utils/assistant-mocks';
import { openAssistantWorkspace } from './utils/assistant-workspace';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';

// Assistant-UI E2E (web): the panel runs in its hosted-provider shape, with
// `/api/assistant/status` mocked so a provider and model resolve without a
// server key. Every test here exercises thread surfaces, identity and tab
// mechanics, none of which depend on a turn being sent. The send-driven
// coverage lives in `assistant-thread-tab-runs.test.ts`.

const ASSISTANT_UI_PANEL_ROOT_NAME = 'assistant-ui-panel';
const ASSISTANT_UI_PANEL_TREE = {
  'README.md': '# BrainStrike test workspace',
};
// Report interaction latency separately from functional visibility assertions,
// so a loaded runner identifies a performance-budget miss rather than disguising
// it as a missing icon/color regression.
//
// The swatches lock while saving, so this budget covers the durable metadata
// write. On web that write waits its turn in the single PGlite worker queue,
// behind background polls and live-query refreshes, at about ten
// BroadcastChannel round trips per query (BST-1961). Locally each step takes
// 75–200 ms. Under 4–6× CPU throttling it reaches the budget, which is how the
// GitHub-hosted runs failed. The quarantine stays until that latency is fixed
// (BST-2116); raising the budget instead would be a reactive floor bump, which
// the calibration contract in `utils/performance-config.ts` rules out.
const THREAD_CUSTOMIZATION_FEEDBACK_BUDGET_MS = 1000;

interface AssistantThreadStartupEvent {
  readonly kind: 'error' | 'loading';
  readonly marker: string;
}

async function readWebE2eDbPath(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
      .__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Expected web E2E hooks to be available');
    }
    return hooks.dbPath;
  });
}

// Assistant threads persist under the workspace-global resource id (see
// WORKSPACE_MEMORY_RESOURCE_ID in packages/assistant-data/src/assistant-memory-resource.ts —
// not exported from the package barrel, hence the literal), not the focused
// root name, since #1214 made threads workspace-global.
const WORKSPACE_MEMORY_RESOURCE_ID = 'brainstrike:workspace';

async function readFirstAssistantThreadMetadata(
  page: Page,
  resourceId = WORKSPACE_MEMORY_RESOURCE_ID
): Promise<unknown> {
  return await page.evaluate(async (targetResourceId) => {
    const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
      .__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Expected web E2E hooks to be available');
    }
    const threads = await hooks.readAssistantThreads();
    return threads.find((thread) => thread.resourceId === targetResourceId)?.metadata ?? null;
  }, resourceId);
}

async function restoreAssistantFixtureRoot(page: Page): Promise<void> {
  await page.evaluate(
    async (fixture: { readonly name: string; readonly tree: typeof ASSISTANT_UI_PANEL_TREE }) => {
      const loadFixture = (
        window as unknown as {
          __BRAINSTRIKE_LOAD_FIXTURE__?: (nextFixture: unknown) => Promise<unknown>;
        }
      ).__BRAINSTRIKE_LOAD_FIXTURE__;
      if (typeof loadFixture !== 'function') {
        throw new Error('Expected fixture loader to be available after reload');
      }
      await loadFixture(fixture);
    },
    {
      name: ASSISTANT_UI_PANEL_ROOT_NAME,
      tree: ASSISTANT_UI_PANEL_TREE,
    }
  );
}

test.describe('Assistant UI panel (web, assistant-ui mode) @stateful @web-assistant-state', () => {
  test.beforeEach(async ({ page }) => {
    // No `__assistantAvailabilityOverride` here, deliberately: it REPLACES the
    // whole availability status, so forcing `{ state: 'enabled' }` would drop
    // the provider and model `/api/assistant/status` reports and leave the
    // composer's control dock unrendered. The old suite needed it because the
    // in-renderer local path had no status endpoint to answer from.
    await page.addInitScript(() => {
      const startupEvents: AssistantThreadStartupEvent[] = [];
      const startupEventKeys = new Set<string>();
      const recordStartupEvent = (kind: AssistantThreadStartupEvent['kind'], marker: string) => {
        const key = `${kind}:${marker}`;
        if (startupEventKeys.has(key)) {
          return;
        }
        startupEventKeys.add(key);
        startupEvents.push({ kind, marker });
      };
      const recordAssistantThreadStartupText = () => {
        const surfaces = [
          ...document.querySelectorAll<HTMLElement>('[data-testid="threads-panel"]'),
          ...document.querySelectorAll<HTMLElement>(
            '[data-testid="assistant-thread-tabs-workspace"]'
          ),
        ];
        for (const surface of surfaces) {
          const loadingSurfaces = surface.querySelectorAll(
            '[data-testid="threads-loading-card"], [data-testid="assistant-thread-workspace-state"]:not([data-variant="error"])'
          );
          for (const element of loadingSurfaces) {
            recordStartupEvent('loading', element.getAttribute('data-testid') ?? 'loading');
          }
          const errorSurfaces = surface.querySelectorAll(
            '[data-testid="threads-error-card"], [data-testid="assistant-thread-workspace-state"][data-variant="error"]'
          );
          for (const element of errorSurfaces) {
            recordStartupEvent('error', element.getAttribute('data-testid') ?? 'error');
          }
        }
      };
      const installAssistantThreadStartupObserver = () => {
        const target = document.documentElement;
        if (!target) {
          window.setTimeout(installAssistantThreadStartupObserver, 0);
          return;
        }
        const observer = new MutationObserver(recordAssistantThreadStartupText);
        observer.observe(target, { characterData: true, childList: true, subtree: true });
        recordAssistantThreadStartupText();
      };
      Object.defineProperty(window, '__assistantThreadStartupEvents', {
        configurable: true,
        value: startupEvents,
      });
      installAssistantThreadStartupObserver();
    });

    await mockAssistantApi(page, HOSTED_ASSISTANT_STATUS);
    await openAssistantWorkspace(page, {
      rootName: ASSISTANT_UI_PANEL_ROOT_NAME,
      tree: ASSISTANT_UI_PANEL_TREE,
    });
  });

  test('loads assistant thread surfaces without startup error states', async ({ page }) => {
    await expect(page.getByTestId('threads-panel')).toBeVisible();
    await expect(page.getByTestId('assistant-thread-tabs-workspace')).toBeVisible();
    const startupEvents = await page.evaluate(
      () =>
        (window as unknown as { __assistantThreadStartupEvents?: AssistantThreadStartupEvent[] })
          .__assistantThreadStartupEvents ?? []
    );
    expect(startupEvents.filter((event) => event.kind === 'error')).toEqual([]);
    await expect(page.getByText('Failed to load threads')).toHaveCount(0);
    await expect(page.getByText('Assistant threads failed to load')).toHaveCount(0);
    await expect(page.getByText('Assistant memory database unavailable')).toHaveCount(0);
    await expect(page.getByText('Memory database unavailable')).toHaveCount(0);
  });

  test.fixme('customizes thread identity and keeps diagnostics out of the primary row', {
    annotation: { description: 'BST-1961', type: 'quarantine' },
  }, async ({ page }) => {
    await expect(page.getByTestId('threads-panel')).toBeVisible();
    const threadRow = page.getByTestId('thread-row').first();
    await expect(threadRow).toBeVisible();
    await expect(threadRow).not.toContainText(/thread-[0-9a-f-]+/i);
    const threadTab = page
      .getByRole('tablist', { name: 'Open assistant threads' })
      .getByRole('tab')
      .first();
    await expect(threadTab).toBeVisible();
    // The tab renders the Threads-panel identity mark itself (BST-1838).
    await expect(threadTab.getByTestId('thread-icon-message')).toBeVisible();

    // Customization moved into the row's "Thread actions" popover (#1661). The
    // popover renders in a portal, so its controls are scoped to the open
    // popover (role=dialog) rather than the row — page-wide getByRole would
    // collide with the group popover's identically-named items. Escape closes
    // it (and exits customize mode) before the flow interacts with the row
    // again; the toHaveCount(0) barrier pins that both `actionsOpen` and
    // `customizing` actually cleared (BST-1033).
    await threadRow.getByRole('button', { name: /Thread actions/i }).click();
    const threadActions = page.getByRole('dialog');
    await threadActions.getByRole('button', { name: 'Customize' }).click();
    const iconCustomizationStartedAt = Date.now();
    await threadActions.getByRole('button', { name: 'Use Bug icon' }).click();
    await expect(threadRow.getByTestId('thread-icon-bug')).toBeVisible();
    await expect(threadTab.getByTestId('thread-icon-bug')).toBeVisible();
    expect(
      Date.now() - iconCustomizationStartedAt,
      'Thread icon customization exceeded the click-to-paint performance budget.'
    ).toBeLessThan(THREAD_CUSTOMIZATION_FEEDBACK_BUDGET_MS);

    const colorCustomizationStartedAt = Date.now();
    await threadActions.getByRole('button', { name: 'Use Rose color' }).click();
    await expect(threadRow.getByTestId('thread-color-rose')).toBeVisible();
    await expect(threadTab.getByTestId('thread-color-rose')).toBeVisible();
    expect(
      Date.now() - colorCustomizationStartedAt,
      'Thread color customization exceeded the click-to-paint performance budget.'
    ).toBeLessThan(THREAD_CUSTOMIZATION_FEEDBACK_BUDGET_MS);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('thread-customization-panel')).toHaveCount(0);

    await expect(threadRow.getByTestId('thread-icon-bug')).toBeVisible();
    await expect(threadRow.getByTestId('thread-color-rose')).toBeVisible();
    await expect(threadRow).not.toContainText(/thread-[0-9a-f-]+/i);

    await threadRow.getByRole('button', { name: /Show thread details/ }).click();
    await expect(threadRow.getByTestId('thread-expanded-details')).toContainText('Diagnostics');
    await expect(threadRow.getByTestId('thread-expanded-details')).toContainText(
      /thread-[0-9a-f-]+/i
    );

    await expect
      .poll(async () => await readFirstAssistantThreadMetadata(page))
      .toMatchObject({ color: 'rose', icon: 'bug' });
    await page.waitForFunction(() =>
      Boolean(
        (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
          .__brainstrikeWebE2ETestHooks__
      )
    );
    await page.evaluate(async () => {
      await (
        window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks }
      ).__brainstrikeWebE2ETestHooks__?.syncDatabase();
    });
    const dbPathBeforeReload = await readWebE2eDbPath(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: true });
    await restoreAssistantFixtureRoot(page);
    await expect(page.getByTestId('assistant-thread-tabs-workspace')).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(async () => await readWebE2eDbPath(page), {
        message: 'Expected the Playwright E2E DB path to stay stable across reload',
      })
      .toBe(dbPathBeforeReload);
    await expect
      .poll(async () => await readFirstAssistantThreadMetadata(page))
      .toMatchObject({ color: 'rose', icon: 'bug' });
    const reloadedThreadRow = page.getByTestId('thread-row').first();
    await expect(reloadedThreadRow).toBeVisible();
    await expect(reloadedThreadRow.getByTestId('thread-icon-bug')).toBeVisible();
    await expect(reloadedThreadRow.getByTestId('thread-color-rose')).toBeVisible();
    await expect(reloadedThreadRow).not.toContainText(/thread-[0-9a-f-]+/i);
    const reloadedThreadTab = page
      .getByRole('tablist', { name: 'Open assistant threads' })
      .getByRole('tab')
      .first();
    await expect(reloadedThreadTab.getByTestId('thread-icon-bug')).toBeVisible();
    await expect(reloadedThreadTab.getByTestId('thread-color-rose')).toBeVisible();
  });

  test('tracks concurrent thread activity from durable runs and clears every terminal spinner', async ({
    page,
  }) => {
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.getByTestId('new-agent-button').click();
    await expect(page.getByTestId('thread-row')).toHaveCount(2);
    // Rows and thread tabs render the same identity mark (BST-1838), so each
    // surface's running badges are counted on their own.
    const rowSpinners = page.getByTestId('threads-panel').getByTestId('thread-active-spinner');
    const tabSpinners = page
      .getByRole('tablist', { name: 'Open assistant threads' })
      .getByTestId('thread-active-spinner');

    const threads = await page.evaluate(async (resourceId) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        throw new Error('Expected web E2E hooks to be available');
      }
      return (await hooks.readAssistantThreads()).filter(
        (thread) => thread.resourceId === resourceId
      );
    }, WORKSPACE_MEMORY_RESOURCE_ID);
    expect(threads).toHaveLength(2);
    const firstThread = threads[0];
    const secondThread = threads[1];
    if (!(firstThread && secondThread)) {
      throw new Error('Expected two assistant threads for concurrent activity coverage');
    }
    const firstRunId = `e2e-active-run-${crypto.randomUUID()}`;
    const secondRunId = `e2e-active-run-${crypto.randomUUID()}`;
    await page.evaluate(
      async ({ first, firstId, resourceId, second, secondId }) => {
        const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
          .__brainstrikeWebE2ETestHooks__;
        if (!hooks) {
          throw new Error('Expected web E2E hooks to be available');
        }
        await Promise.all([
          hooks.createAssistantThreadRun({ id: firstId, resourceId, threadId: first }),
          hooks.createAssistantThreadRun({ id: secondId, resourceId, threadId: second }),
        ]);
      },
      {
        first: firstThread.id,
        firstId: firstRunId,
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        second: secondThread.id,
        secondId: secondRunId,
      }
    );

    await expect(rowSpinners).toHaveCount(2);
    await expect(tabSpinners).toHaveCount(2);
    await expect(
      page.getByTestId('thread-row').locator('[data-testid^="thread-icon-"]')
    ).toHaveCount(2);
    await expect(rowSpinners.first()).toHaveCSS('animation-name', 'none');

    await page.evaluate(async (runId) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        throw new Error('Expected web E2E hooks to be available');
      }
      await hooks.completeAssistantThreadRun(runId, 'completed');
    }, firstRunId);
    await expect(rowSpinners).toHaveCount(1);
    await expect(tabSpinners).toHaveCount(1);

    await page.evaluate(async (runId) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        throw new Error('Expected web E2E hooks to be available');
      }
      await hooks.completeAssistantThreadRun(runId, 'failed');
    }, secondRunId);
    await expect(rowSpinners).toHaveCount(0);
    await expect(tabSpinners).toHaveCount(0);
    await expect(
      page.getByTestId('thread-row').locator('[data-testid^="thread-icon-"]')
    ).toHaveCount(2);

    const cancellationRunId = `e2e-cancelled-run-${crypto.randomUUID()}`;
    await page.evaluate(
      async ({ resourceId, runId, threadId }) => {
        const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
          .__brainstrikeWebE2ETestHooks__;
        if (!hooks) {
          throw new Error('Expected web E2E hooks to be available');
        }
        await hooks.createAssistantThreadRun({ id: runId, resourceId, threadId });
      },
      {
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        runId: cancellationRunId,
        threadId: firstThread.id,
      }
    );
    await expect(rowSpinners).toHaveCount(1);
    await page.evaluate(async (runId) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        throw new Error('Expected web E2E hooks to be available');
      }
      await hooks.completeAssistantThreadRun(runId, 'cancelled');
    }, cancellationRunId);
    await expect(rowSpinners).toHaveCount(0);

    const orphanedRunId = `e2e-orphaned-run-${crypto.randomUUID()}`;
    await page.evaluate(
      async ({ resourceId, runId, startedAt, threadId }) => {
        const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
          .__brainstrikeWebE2ETestHooks__;
        if (!hooks) {
          throw new Error('Expected web E2E hooks to be available');
        }
        await hooks.createAssistantThreadRun({ id: runId, resourceId, startedAt, threadId });
        await hooks.syncDatabase();
      },
      {
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        runId: orphanedRunId,
        startedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        threadId: firstThread.id,
      }
    );
    await expect(rowSpinners).toHaveCount(1);

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: true });
    await restoreAssistantFixtureRoot(page);
    await expect(page.getByTestId('assistant-thread-tabs-workspace')).toBeVisible({
      timeout: 15_000,
    });
    await expect(rowSpinners).toHaveCount(0);
  });

  test('keeps thread identity aligned when switching into rename mode', async ({ page }) => {
    await expect(page.getByTestId('threads-panel')).toBeVisible();
    const threadRow = page.getByTestId('thread-row').first();
    await expect(threadRow).toBeVisible();
    // Color-agnostic identity-mark locator: threads without explicit color
    // metadata render `thread-color-unassigned` since #1643 (was blue before);
    // this test pins the mark's ALIGNMENT across modes, not its color
    // (BST-1034).
    const renderedIdentity = threadRow.locator('[data-testid^="thread-color-"]');
    await expect(renderedIdentity).toBeVisible();
    const renderedBox = await renderedIdentity.boundingBox();
    expect(renderedBox).not.toBeNull();

    // Rename moved into the row's "Thread actions" popover (#1661), scoped to
    // the open popover like the customize/delete flows.
    await threadRow.getByRole('button', { name: /Thread actions/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click();
    const editIdentity = threadRow.locator('[data-testid^="thread-color-"]');
    await expect(editIdentity).toBeVisible();
    const editBox = await editIdentity.boundingBox();
    expect(editBox).not.toBeNull();

    expect(Math.abs((renderedBox?.x ?? 0) - (editBox?.x ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((renderedBox?.y ?? 0) - (editBox?.y ?? 0))).toBeLessThanOrEqual(1);
  });

  // The original suite also drove five turns through this composer to pin the
  // expandable-message and jump-to-latest behaviour. That half needs a sendable
  // composer, which web no longer has (see assistant-thread-tab-runs.test.ts),
  // so only the dock LAYOUT contract (BST-950) is covered here.
  test('keeps composer controls in the input shell', async ({ page }) => {
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }

    const viewport = page.getByTestId('assistant-ui-viewport');
    const composerShell = page.getByTestId('assistant-composer-shell');
    await expect(viewport).toBeVisible();
    await expect(composerShell).toBeVisible();
    await expect(composerShell.getByTestId('assistant-composer-controls')).toBeVisible();
    await expect(composerShell.getByRole('button', { exact: true, name: 'Send' })).toBeVisible();
    await expect(composerShell.getByText('Send', { exact: true })).toHaveCount(0);

    const modelBox = await composerShell
      .getByTestId('assistant-model-dropdown')
      .getByTestId('composer-model-menu-trigger')
      .boundingBox();
    const controlsBox = await composerShell
      .getByRole('button', { name: 'Open assistant controls' })
      .boundingBox();

    expect(modelBox).not.toBeNull();
    expect(controlsBox).not.toBeNull();
    await expect(composerShell.getByTestId('assistant-context-summary')).toHaveCount(0);
    if (!(modelBox && controlsBox)) {
      throw new Error('Assistant composer control alignment boxes were unavailable.');
    }

    // The dock is a wrapping flex row (BST-950): chips that share a line must
    // be dead-centered (2px absorbs sub-pixel rounding only), and when the
    // panel is too narrow to fit them the wrap must be clean — stacked rows,
    // never overlapping. Measured at the default layout (1280px viewport) all
    // chips share one line; the wrap branch guards narrow-panel layouts.
    const modelCenterY = modelBox.y + modelBox.height / 2;
    const controlsCenterY = controlsBox.y + controlsBox.height / 2;
    const sharesRow = Math.abs(modelBox.y - controlsBox.y) < 1;
    if (sharesRow) {
      expect(Math.abs(modelCenterY - controlsCenterY)).toBeLessThan(2);
    } else {
      expect(controlsBox.y).toBeGreaterThanOrEqual(modelBox.y + modelBox.height - 1);
    }
  });

  test('deletes assistant thread history without loading errors', async ({ page }) => {
    await expect(page.getByTestId('threads-panel')).toBeVisible();
    await page.getByTestId('new-agent-button').click();
    await expect(page.getByTestId('thread-row')).toHaveCount(2);

    const newestThread = page.getByTestId('thread-row').first();
    // Deletion moved into the row's "Thread actions" popover (#1661); the
    // Delete item (scoped to the open popover to avoid the group popover's
    // identically-named item) closes the popover and opens the inline row
    // confirm (aria-label "Confirm delete thread …") — BST-1035.
    await newestThread.getByRole('button', { name: /Thread actions/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Delete/ })
      .click();
    await page.getByRole('button', { name: /Confirm delete thread/i }).click();

    await expect(page.getByTestId('thread-row')).toHaveCount(1);
    await expect(page.getByText('Failed to load threads')).toHaveCount(0);
    await expect(page.getByText('Assistant threads failed to load')).toHaveCount(0);
  });

  test('keeps the assistant tab controller stable when tabs overflow', async ({ page }) => {
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }

    const tabStrip = page.getByTestId('assistant-thread-tab-strip');
    const tabScroll = page.getByTestId('assistant-thread-tab-scroll');
    const tabList = page.getByRole('tablist', { name: 'Open assistant threads' });
    const newThreadButton = page.getByTestId('assistant-new-thread-button');
    const allTabsButton = tabStrip.getByRole('button', { name: 'All tabs' });

    await expect(tabStrip).toBeVisible();
    await expect(tabScroll).toBeVisible();
    await expect(newThreadButton).toBeVisible();
    await expect(allTabsButton).toBeVisible();
    // BST-1836 D2: no scroll chevrons; fades, wheel and the All-tabs menu own overflow.
    await expect(tabStrip.getByRole('button', { name: /Scroll assistant tabs/ })).toHaveCount(0);

    const initialTabCount = await tabList.getByRole('tab').count();
    const initialButtonBox = await newThreadButton.boundingBox();
    const initialFirstTabBox = await tabList.getByRole('tab').first().boundingBox();

    expect(initialButtonBox).not.toBeNull();
    expect(initialFirstTabBox).not.toBeNull();
    if (!(initialButtonBox && initialFirstTabBox)) {
      throw new Error('Assistant tab controller boxes were unavailable before overflow.');
    }

    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (let index = 1; index <= 8; index += 1) {
      await newThreadButton.click();
      await expect(tabList.getByRole('tab')).toHaveCount(initialTabCount + index);
    }

    const scrollMetrics = await tabScroll.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(scrollMetrics.scrollWidth).toBeGreaterThan(scrollMetrics.clientWidth);
    // The newest tab is revealed at the end, so only the start edge fades.
    await expect(tabScroll).toHaveAttribute('data-overflow-start', 'true');
    await expect(tabScroll).not.toHaveAttribute('data-overflow-end', 'true');

    await tabScroll.evaluate((element) => {
      element.scrollTo({ behavior: 'instant', left: 0 });
    });
    await expect(tabScroll).not.toHaveAttribute('data-overflow-start', 'true');
    await expect(tabScroll).toHaveAttribute('data-overflow-end', 'true');

    const overflowButtonBox = await newThreadButton.boundingBox();
    const overflowFirstTabBox = await tabList.getByRole('tab').first().boundingBox();
    const tabListBox = await tabList.boundingBox();

    expect(overflowButtonBox).not.toBeNull();
    expect(overflowFirstTabBox).not.toBeNull();
    expect(tabListBox).not.toBeNull();
    if (!(overflowButtonBox && overflowFirstTabBox && tabListBox)) {
      throw new Error('Assistant tab controller boxes were unavailable after overflow.');
    }

    expect(Math.abs(overflowButtonBox.y - initialButtonBox.y)).toBeLessThan(2);
    expect(Math.abs(overflowButtonBox.height - initialButtonBox.height)).toBeLessThan(2);
    expect(Math.abs(overflowFirstTabBox.y - initialFirstTabBox.y)).toBeLessThan(2);
    expect(Math.abs(overflowFirstTabBox.height - initialFirstTabBox.height)).toBeLessThan(2);
    expect(overflowButtonBox.x).toBeGreaterThanOrEqual(tabListBox.x + tabListBox.width);

    await tabScroll.hover();
    await page.mouse.wheel(0, 240);
    await expect.poll(() => tabScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

    // The All-tabs menu reaches a tab scrolled out of view and reveals it.
    await tabScroll.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await allTabsButton.click();
    const allTabs = page.getByRole('menuitemradio');
    await expect(allTabs).toHaveCount(initialTabCount + 8);
    await allTabs.first().click();
    const firstTab = tabList.getByRole('tab').first();
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => tabScroll.evaluate((element) => element.scrollLeft)).toBe(0);

    const scrolledButtonBox = await newThreadButton.boundingBox();
    expect(scrolledButtonBox).not.toBeNull();
    if (!scrolledButtonBox) {
      throw new Error('Assistant new-thread button disappeared after tab scroll.');
    }
    expect(Math.abs(scrolledButtonBox.x - overflowButtonBox.x)).toBeLessThan(2);
    expect(Math.abs(scrolledButtonBox.y - overflowButtonBox.y)).toBeLessThan(2);
  });
});
