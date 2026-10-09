import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

async function waitForOwnedExit(process: ChildProcess | undefined): Promise<void> {
  if (!process || process.exitCode !== null || process.signalCode !== null) {
    return;
  }
  await once(process, 'exit', { signal: AbortSignal.timeout(5000) });
}

async function openWorkerFromNewActivity(
  window: Page,
  root: Locator,
  previousActivityCount: number,
  expectedTask: string
): Promise<Locator> {
  const groups = root.getByTestId('assistant-activity-group');
  await expect.poll(() => groups.count()).toBeGreaterThan(previousActivityCount);
  const group = groups.nth(previousActivityCount);
  await group.getByRole('button', { exact: true, name: 'Expand activity' }).click();
  await expect(group).toContainText(expectedTask);
  await group.getByRole('button', { name: /Open .* conversation/ }).click();
  const selectedTab = window
    .getByRole('tablist', { name: 'Workspace tabs' })
    .getByRole('tab', { selected: true });
  await expect(selectedTab).toHaveText(/^[A-Z][a-z]+-[a-f0-9]{6}$/);
  const name = (await selectedTab.innerText()).trim();
  return window.getByRole('region', { exact: true, name });
}

async function expandActivity(region: Locator): Promise<void> {
  const expand = region.getByRole('button', { exact: true, name: 'Expand activity' });
  const collapse = region.getByRole('button', { exact: true, name: 'Collapse activity' });
  await expect(expand.or(collapse)).toBeVisible();
  if (await expand.count()) {
    await expand.click();
  }
}

test('delegated command asks by default, then a per-tool grant streams output and persists its result', async ({
  electron,
}, testInfo) => {
  const failures: unknown[] = [];
  let ownedProcess: ChildProcess | undefined;
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-worker-command-'));
  const requireAdvertisedTool = (toolNames: readonly string[], name: string): void => {
    try {
      expect(toolNames).toContain(name);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  };
  const provider = await startModelProviderShim(({ messages, toolNames }) => {
    if (toolNames.length === 0) {
      return { finalText: 'Worker command task' };
    }
    const directUserIndices = messages.flatMap((message, index) =>
      message &&
      typeof message === 'object' &&
      'role' in message &&
      message.role === 'user' &&
      !JSON.stringify(message).includes('Background invocations of this turn')
        ? [index]
        : []
    );
    const taskIndex = directUserIndices.at(-1);
    const task = JSON.stringify(taskIndex === undefined ? undefined : messages[taskIndex]);
    const history = JSON.stringify(messages.slice(taskIndex));
    const second = task.includes('SECOND');
    const suffix = second ? 'SECOND' : 'FIRST';
    if (task.includes('WORKER_COMMAND')) {
      requireAdvertisedTool(toolNames, 'brainstrike_executeCommand');
      return {
        finalText: `CHILD_${suffix}_COMMAND_COMPLETE`,
        toolCall: {
          arguments: {
            command: `printf 'started' > started-${suffix.toLowerCase()}.txt; printf 'STREAM_STDOUT_${suffix}\\n'; printf 'STREAM_STDERR_${suffix}\\n' >&2; while test ! -f release-${suffix.toLowerCase()}.txt; do sleep 0.1; done; printf 'STREAM_DONE_${suffix}\\n'`,
          },
          name: 'brainstrike_executeCommand',
        },
      };
    }
    requireAdvertisedTool(toolNames, 'agent-worker');
    if (history.includes(`CHILD_${suffix}_COMMAND_COMPLETE`)) {
      return { finalText: `ROOT_${suffix}_COMMAND_COMPLETE` };
    }
    if (history.includes('Background task started.')) {
      return { finalText: `ROOT_${suffix}_WAITING` };
    }
    return {
      finalText: `ROOT_${suffix}_DISPATCHED`,
      toolCall: {
        arguments: {
          prompt: `WORKER_COMMAND_${suffix}: Run the requested disposable command and report its stdout and stderr.`,
        },
        name: 'agent-worker',
      },
    };
  });
  const environment = {
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: 'isolated-worker-command-key',
    OPENROUTER_BASE_URL: provider.baseUrl,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  try {
    const window = await electron.ensureWindow();
    ownedProcess = (await electron.ensureContext()).app.process();
    try {
      await ensureMockWorkspaceOpen(window);
      await configureAssistantProvider(window, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
      await new HomePage(window).openSettings();
      await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
      await window
        .getByRole('combobox', { exact: true, name: 'Execute permission' })
        .selectOption('ask');
      await window
        .getByRole('combobox', { exact: true, name: 'Read permission' })
        .selectOption('allow');
      await ensureAssistantShellVisible(window);
      const root = window.getByRole('region', { exact: true, name: 'Assistant' });
      const firstActivityCount = await root.getByTestId('assistant-activity-group').count();
      await root
        .getByRole('textbox', { name: 'Message input' })
        .fill('ROOT_FIRST_COMMAND: Delegate the first disposable shell command to Worker.');
      await root.getByRole('button', { exact: true, name: 'Send' }).click();
      const first = await openWorkerFromNewActivity(
        window,
        root,
        firstActivityCount,
        'WORKER_COMMAND_FIRST'
      );
      const approvalName = 'Approve brainstrike.executeCommand';
      await expect(first.getByRole('button', { exact: true, name: approvalName })).toBeVisible();
      for (const surface of [root, first]) {
        await expect(surface.getByText('Waiting for approval', { exact: true })).toHaveCount(0);
        await expect(surface.getByText('Awaiting your approval', { exact: true })).toHaveCount(0);
      }
      await expect(readFile(path.join(workspace, 'started-first.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const viewport = first.getByTestId('assistant-ui-viewport');
      // Let initial bottom-follow finish, then establish the user's scroll
      // position before checking that the review dialog leaves it alone.
      await expect
        .poll(() =>
          viewport.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop
          )
        )
        .toBeLessThanOrEqual(1);
      await viewport.hover();
      await window.mouse.wheel(0, -(await viewport.evaluate((element) => element.scrollHeight)));
      await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
      const scrollTop = await viewport.evaluate((element) => element.scrollTop);
      await first.getByRole('button', { name: 'Review 1 pending approval' }).click();
      const review = window.getByRole('dialog', { name: 'Pending approvals' });
      await expect(review).toBeInViewport({ ratio: 1 });
      await expect(review.getByTestId('approval-command-code')).toContainText(
        "printf 'started' > started-first.txt"
      );
      await expect(review.getByTestId('approval-command-code')).toContainText(
        "printf 'STREAM_DONE_FIRST\\n'"
      );
      expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scrollTop);
      await testInfo.attach('pending-review-layout', {
        body: JSON.stringify({ dialog: await review.boundingBox(), viewportScrollTop: scrollTop }),
        contentType: 'application/json',
      });
      await testInfo.attach('pending-command-review', {
        body: await review.screenshot(),
        contentType: 'image/png',
      });
      // This grants the exact tool in this test's disposable profile, leaving
      // the execute category at ask for other commands.
      await review
        .getByRole('button', { exact: true, name: 'Always allow brainstrike.executeCommand' })
        .click();
      await review.getByRole('button', { name: 'Close pending approvals' }).click();
      // An approval-bearing call is a standalone card outside activity groups (BST-1977).
      await expect(first.getByRole('log', { name: 'Live command output' })).toContainText(
        'STREAM_STDOUT_FIRST',
        { timeout: 15_000 }
      );
      await expect(first.getByRole('log', { name: 'Live command output' })).toContainText(
        'STREAM_STDERR_FIRST'
      );
      await writeFile(path.join(workspace, 'release-first.txt'), 'go');
      await expect(first.getByText('CHILD_FIRST_COMMAND_COMPLETE', { exact: true })).toBeVisible();
      await expect(root.getByText('ROOT_FIRST_COMMAND_COMPLETE', { exact: true })).toBeVisible();
      await expect(root.getByText('ROOT_FIRST_COMMAND_COMPLETE', { exact: true })).toHaveCount(1);
      expect(await readFile(path.join(workspace, 'started-first.txt'), 'utf8')).toBe('started');
      for (const surface of [root, first]) {
        await expect(surface.getByText('Waiting for approval', { exact: true })).toHaveCount(0);
        await expect(surface.getByText('Awaiting your approval', { exact: true })).toHaveCount(0);
        await expect(surface.getByRole('button', { exact: true, name: approvalName })).toHaveCount(
          0
        );
        await expect(
          surface.getByRole('button', { exact: true, name: 'Decline brainstrike.executeCommand' })
        ).toHaveCount(0);
      }
      const history = root.getByTestId('assistant-tool-approval-notice');
      await expect(history).toContainText('Approved');
      await history.getByRole('button', { name: /show approval details/i }).click();
      await expect(history.getByRole('button', { exact: true, name: approvalName })).toHaveCount(0);
      await expect(history).toContainText("printf 'started' > started-first.txt");
      await testInfo.attach('answered-command-history', {
        body: await window.screenshot(),
        contentType: 'image/png',
      });
      const firstTab = window
        .getByRole('tablist', { name: 'Workspace tabs' })
        .getByRole('tab', { selected: true });
      const firstName = (await firstTab.innerText()).trim();
      // The tab ✕ is a mouse-only, aria-hidden sibling of the tab that shows on
      // hover (TabStrip contract), so point at the tab first.
      await window.getByRole('tab', { exact: true, name: firstName }).hover();
      await window
        .getByRole('button', { exact: true, includeHidden: true, name: `Close ${firstName}` })
        .click();

      const secondActivityCount = await root.getByTestId('assistant-activity-group').count();
      await root
        .getByRole('textbox', { name: 'Message input' })
        .fill('ROOT_SECOND_COMMAND: Delegate another disposable shell command to Worker.');
      await root.getByRole('button', { exact: true, name: 'Send' }).click();
      const second = await openWorkerFromNewActivity(
        window,
        root,
        secondActivityCount,
        'WORKER_COMMAND_SECOND'
      );
      await expandActivity(second);
      await expect(second.getByRole('button', { exact: true, name: approvalName })).toHaveCount(0);
      await expect(second.getByRole('log', { name: 'Live command output' })).toContainText(
        'STREAM_STDOUT_SECOND',
        { timeout: 15_000 }
      );
      await expect(second.getByRole('log', { name: 'Live command output' })).toContainText(
        'STREAM_STDERR_SECOND'
      );
      await writeFile(path.join(workspace, 'release-second.txt'), 'go');
      await expect(
        second.getByText('CHILD_SECOND_COMMAND_COMPLETE', { exact: true })
      ).toBeVisible();
      await expect(root.getByText('ROOT_SECOND_COMMAND_COMPLETE', { exact: true })).toBeVisible();
      await expect(root.getByText('ROOT_SECOND_COMMAND_COMPLETE', { exact: true })).toHaveCount(1);
      expect(await readFile(path.join(workspace, 'started-second.txt'), 'utf8')).toBe('started');
      const toolCard = second.getByTestId('tool-fallback').last();
      await toolCard.getByRole('button').first().click();
      await expect(toolCard.getByText('Result:', { exact: true })).toBeVisible();
      await expect(toolCard.locator('pre').last()).toContainText('STREAM_STDOUT_SECOND');
      await expect(toolCard.locator('pre').last()).toContainText('STREAM_STDERR_SECOND');
      await expect(root.getByRole('button', { exact: true, name: 'Send' })).toBeVisible();
      await expect(root.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
      // A reload must not call the model; count generations, not metadata reads.
      const completedRequests = provider.requests().length;
      await window.reload();
      await ensureAssistantShellVisible(window);
      await expect(
        second.getByText('CHILD_SECOND_COMMAND_COMPLETE', { exact: true })
      ).toBeVisible();
      await expect(root.getByText('ROOT_SECOND_COMMAND_COMPLETE', { exact: true })).toBeVisible();
      await expandActivity(second);
      const persistedToolCard = second.getByTestId('tool-fallback').last();
      await persistedToolCard.getByRole('button').first().click();
      await expect(persistedToolCard.locator('pre').last()).toContainText('STREAM_STDOUT_SECOND');
      await expect(persistedToolCard.locator('pre').last()).toContainText('STREAM_STDERR_SECOND');
      expect(provider.requests().length).toBe(completedRequests);
      await window.screenshot({ path: testInfo.outputPath('worker-command-result.png') });
    } catch (error) {
      failures.push(error);
      try {
        await window.screenshot({ path: testInfo.outputPath('worker-command-failure.png') });
      } catch (screenshotError) {
        failures.push(screenshotError);
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    // Release a held command even when the live-output assertion is red.
    for (const release of ['first', 'second']) {
      try {
        await writeFile(path.join(workspace, `release-${release}.txt`), 'go');
      } catch (releaseError) {
        failures.push(releaseError);
      }
    }
    for (const cleanup of [
      async () => electron.dispose(),
      async () => waitForOwnedExit(ownedProcess),
      async () => provider.close(),
      async () => {
        for (const key of Object.keys(environment)) {
          const value = previous[key];
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      },
      async () => {
        if (ownedProcess && ownedProcess.exitCode === null && ownedProcess.signalCode === null) {
          throw new Error('Workspace retained because the Electron process is still running');
        }
        await rm(workspace, { force: true, recursive: true });
      },
    ]) {
      try {
        await cleanup();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Worker command acceptance and cleanup failed', {
      cause: failures[0],
    });
  }
});
