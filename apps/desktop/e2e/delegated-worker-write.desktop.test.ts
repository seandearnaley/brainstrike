import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Locator, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import {
  ensureActivityExpanded,
  ensureAssistantShellVisible,
  ensureMockWorkspaceOpen,
} from './utils/layout-helpers';
import { type ModelProviderShim, startModelProviderShim } from './utils/model-provider-shim';

async function waitForOwnedExit(process: ChildProcess | undefined): Promise<void> {
  if (!process || process.exitCode !== null || process.signalCode !== null) {
    return;
  }
  await once(process, 'exit', { signal: AbortSignal.timeout(5000) });
}

// A new, previously absent file is deliberately used: runWriteWorkspaceFile's
// staleness guard permits new/unobserved files. Existing-file edit acceptance
// must read first; this case does not manufacture a read failure for a new file.
test('worker Approve controls a reloaded disposable workspace write @smoke', async ({
  electron,
}, testInfo) => {
  await assertWorkerWrite(electron, testInfo, { decision: 'Approve' });
});
test('worker Decline controls a reloaded disposable workspace write @smoke', async ({
  electron,
}, testInfo) => {
  await assertWorkerWrite(electron, testInfo, { decision: 'Decline' });
});

test('recursive worker reloads its leaf approval and returns the result through three levels @smoke', async ({
  electron,
}, testInfo) => {
  await assertWorkerWrite(electron, testInfo, { decision: 'Approve', depth: 3 });
});

test('background worker survives a host restart with its pending approval and writes once @smoke', async ({
  electron,
}, testInfo) => {
  await assertWorkerWrite(electron, testInfo, { decision: 'Approve', restartHost: true });
});

test('stops a reloaded pending child and preserves parent interaction @smoke', async ({
  electron,
}, testInfo) => {
  await assertWorkerWrite(electron, testInfo, { decision: 'Stop' });
});

test('worker attributes an allowed write without a preceding human pause @smoke', async ({
  electron,
}, testInfo) => {
  await assertWorkerWrite(electron, testInfo, { autoApprove: true, decision: 'Approve' });
});

/** How each child thread's runs ended, as the agent host committed them. */
async function childOutcomes(userDataDir: string): Promise<readonly string[]> {
  return (await readHostThreadTree(userDataDir))
    .filter(({ parentThreadId }) => parentThreadId !== undefined)
    .flatMap(({ rows }) =>
      rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []))
    );
}

/** The root thread's committed runs: the delivery each answered, and how it ended. */
async function rootRuns(userDataDir: string) {
  const rows =
    (await readHostThreadTree(userDataDir)).find(
      ({ parentThreadId }) => parentThreadId === undefined
    )?.rows ?? [];
  return rows.flatMap(({ event }) =>
    event.type === 'run.started'
      ? [
          {
            outcome:
              rows.flatMap(({ event: later }) =>
                later.type === 'run.finished' && later.runId === event.runId ? [later.outcome] : []
              )[0] ?? 'running',
            states: event.delivery?.entries.map(({ state }) => state) ?? [],
            via: event.delivery?.via ?? 'command',
          },
        ]
      : []
  );
}

/**
 * ADR-0010 (case 4, an ADR-mandated behaviour change): "A pending child
 * approval does not survive a restart; it shows as interrupted." Nothing is
 * written, and the parent reads the child's outcome once, on its next turn.
 */
async function expectChildInterruptedByRestart(options: {
  readonly approvalName: string;
  readonly child: Locator;
  readonly outputPath: string;
  readonly provider: ModelProviderShim;
  readonly root: Locator;
  readonly userDataDir: string;
}): Promise<void> {
  const { approvalName, child, outputPath, provider, root, userDataDir } = options;
  // The restarted app publishes its host record once its host is up; until then
  // the read's failure is the polled value, so a host that never returns still fails.
  await expect
    .poll(() => childOutcomes(userDataDir).catch((error: unknown) => String(error)), {
      timeout: 30_000,
    })
    .toEqual(['interrupted']);
  // The reopened child shows its conversation, with no approval left to answer.
  await expect(child.getByText(/WORKER_LEVEL_1/u).first()).toBeVisible();
  await expect(child.getByRole('button', { exact: true, name: approvalName })).toHaveCount(0);
  await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  provider.setScript({ finalText: 'PARENT_READ_INTERRUPTED_CHILD_1721' });
  const answer = root.getByText('PARENT_READ_INTERRUPTED_CHILD_1721', { exact: true });
  for (const [turn, prompt] of ['Continue after the restart.', 'And once more.'].entries()) {
    await root.getByRole('textbox', { name: 'Message input' }).fill(prompt);
    await root.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(answer).toHaveCount(turn + 1);
  }
  // Delivered once: the next turn carries it, and the turn after carries nothing.
  expect(
    (await rootRuns(userDataDir))
      .filter(({ via }) => via !== 'command')
      .map(({ states, via }) => ({ states, via }))
  ).toEqual([{ states: ['failed'], via: 'next-turn' }]);
  expect(
    provider
      .transcript()
      .filter((entry) => entry.decision === 'tool:brainstrike_writeWorkspaceFile')
  ).toHaveLength(1);
  await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}

async function assertWorkerWrite(
  electron: ElectronHarness,
  testInfo: TestInfo,
  {
    decision,
    depth = 1,
    restartHost = false,
    autoApprove = false,
  }: {
    readonly decision: 'Approve' | 'Decline' | 'Stop';
    readonly depth?: number;
    readonly restartHost?: boolean;
    readonly autoApprove?: boolean;
  }
): Promise<void> {
  const failures: unknown[] = [];
  let ownedProcess: ChildProcess | undefined;
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-worker-write-'));
  const outputPath = path.join(workspace, 'worker-output.txt');
  const content = 'WORKER_DISPOSABLE_DELIVERABLE_1721\n';
  const childResult = `WORKER_${decision.toUpperCase()}_RESULT_1721`;
  const parentResult = `PARENT_${decision.toUpperCase()}_RESULT_1721`;
  let resolveAdvertisedTools: (names: readonly string[]) => void = () => {
    throw new Error('Provider observation was not initialized');
  };
  const advertisedTools = new Promise<readonly string[]>((resolve) => {
    resolveAdvertisedTools = resolve;
  });
  const observed = { backgroundStarted: false, parentResult: false, writeResult: false };
  const provider = await startModelProviderShim(({ toolNames, messages }) => {
    if (toolNames.length === 0) {
      return { finalText: 'Worker workspace task' };
    }
    const history = JSON.stringify(messages);
    // A background wakeup is a user message that quotes each invocation's prompt
    // (the WAKEUP LEDGER). It is not this agent's task: matching it would read
    // the root's wakeup as a worker. A child's own task still follows the
    // root's forwarded user message, so the level markers are read across the
    // remaining user messages.
    const task = JSON.stringify(
      messages.filter(
        (message) =>
          message &&
          typeof message === 'object' &&
          'role' in message &&
          message.role === 'user' &&
          !JSON.stringify(message).includes('Background invocations of this turn')
      )
    );
    const level = task.includes('WORKER_LEVEL_3')
      ? 3
      : task.includes('WORKER_LEVEL_2')
        ? 2
        : task.includes('WORKER_LEVEL_1')
          ? 1
          : 0;
    const isParent = level === 0;
    if (isParent) {
      resolveAdvertisedTools(toolNames);
      observed.backgroundStarted ||= history.includes('Background task started.');
      observed.parentResult ||= history.includes(childResult);
      if (history.includes('Background task started.') || history.includes(childResult)) {
        return {
          finalText: history.includes(childResult)
            ? parentResult
            : history.includes('Parent continues useful work while Worker is pending.')
              ? 'Worker needs your approval.'
              : 'Parent continues useful work while Worker is pending.',
        };
      }
      return {
        finalText: parentResult,
        toolCall: {
          arguments: {
            prompt:
              'WORKER_LEVEL_1: Create worker-output.txt with the requested disposable deliverable, delegating onward when instructed.',
          },
          name: 'agent-worker',
        },
      };
    }
    if (level < depth) {
      expect(toolNames).toContain('agent-worker');
      return {
        finalText: childResult,
        toolCall: {
          arguments: {
            prompt: `WORKER_LEVEL_${level + 1}: Create worker-output.txt with the requested disposable deliverable.`,
          },
          name: 'agent-worker',
        },
      };
    }
    // Observe the actual native tool output, not the scripted answer text.
    // `created: true` also rejects a second overwrite masquerading as creation.
    observed.writeResult ||=
      history.includes('bytesWritten') &&
      (history.includes('"created":true') || history.includes('\\"created\\":true'));
    return {
      finalText: childResult,
      toolCall: {
        arguments: { content, path: 'worker-output.txt' },
        name: 'brainstrike_writeWorkspaceFile',
      },
    };
  });
  // A reload must not call the model. The host child view reads the provider's
  // model metadata on mount, which is not a model call, so count generations.
  const modelCalls = (): number => provider.requests().length;
  const environment = {
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: 'isolated-worker-write-key',
    OPENROUTER_BASE_URL: provider.baseUrl,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  try {
    let window = await electron.ensureWindow();
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
        .getByTestId('permission-policy-edit')
        .selectOption(autoApprove ? 'allow' : 'ask');
      await window
        .getByRole('combobox', { exact: true, name: 'Read permission' })
        .selectOption('allow');
      await ensureAssistantShellVisible(window);
      let root = window.getByRole('region', { exact: true, name: 'Assistant' });
      await root
        .getByRole('textbox', { name: 'Message input' })
        .fill(
          'Delegate to Worker to create worker-output.txt with the requested disposable deliverable.'
        );
      await root.getByRole('button', { exact: true, name: 'Send' }).click();
      // Fail as soon as the first real parent model request proves Worker is
      // missing, rather than waiting through child-navigation UI timeouts.
      expect(await advertisedTools, 'Production parent must advertise Worker').toContain(
        'agent-worker'
      );
      const approvalName = 'Approve brainstrike.writeWorkspaceFile';
      if (!autoApprove) {
        await expect(
          root.getByText('Parent continues useful work while Worker is pending.', { exact: true })
        ).toBeVisible();
        await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await root.getByRole('button', { exact: true, name: 'Expand activity' }).click();
      await root.getByRole('button', { name: /Open .* conversation/ }).click();
      const selectedTab = window
        .getByRole('tablist', { name: 'Workspace tabs' })
        .getByRole('tab', { selected: true });
      await expect(selectedTab).toHaveText(/^[A-Z][a-z]+-[a-f0-9]{6}$/);
      await expect(selectedTab).toBeFocused();
      const firstChildName = (await selectedTab.innerText()).trim();
      for (let level = 1; level < depth; level += 1) {
        const currentName = (await selectedTab.innerText()).trim();
        const current = window.getByRole('region', { exact: true, name: currentName });
        await expect(current.getByText('Waiting for approval', { exact: true })).toHaveCount(0);
        // Activity is collapsed by default; the running delegation's card is inside it.
        await ensureActivityExpanded(current);
        await current.getByRole('button', { name: /Open .* conversation/ }).click();
        await expect(selectedTab).not.toHaveText(currentName);
        await expect(selectedTab).toBeFocused();
        await expect(selectedTab).toHaveText(/^[A-Z][a-z]+-[a-f0-9]{6}$/);
        const nextName = (await selectedTab.innerText()).trim();
        const nextPanel = window.getByRole('tabpanel', { exact: true, name: nextName });
        await nextPanel
          .getByRole('navigation', { name: 'Conversation ancestry' })
          .getByRole('button', { exact: true, name: currentName })
          .click();
        const origin = current.getByRole('button', { name: /Open .* conversation/ });
        await expect(origin).toBeFocused();
        await origin.press('Enter');
        await expect(selectedTab).toHaveText(nextName);
      }
      const childName = (await selectedTab.innerText()).trim();
      let child = window.getByRole('region', { exact: true, name: childName });
      if (!autoApprove) {
        await expect(child.getByRole('button', { exact: true, name: approvalName })).toBeVisible();
        const pendingRequests = modelCalls();
        if (restartHost) {
          const oldProcessId = (await electron.ensureContext()).app.process().pid;
          const stoppedProcess = ownedProcess;
          const [, restarted] = await Promise.all([
            waitForOwnedExit(stoppedProcess),
            electron.restart(),
          ]);
          expect(stoppedProcess?.exitCode).toBe(0);
          ownedProcess = restarted.app.process();
          expect(restarted.app.process().pid).not.toBe(oldProcessId);
          window = restarted.window;
          root = window.getByRole('region', { exact: true, name: 'Assistant' });
          child = window.getByRole('region', { exact: true, name: childName });
        } else {
          await window.reload();
        }
        await configureAssistantProvider(window, {
          compositeModelKey: 'openrouter::openai/gpt-5.4',
          provider: 'openrouter',
        });
        await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
        await ensureAssistantShellVisible(window);
        if (!restartHost) {
          await expect(
            child.getByRole('button', { exact: true, name: approvalName })
          ).toBeVisible();
          expect(modelCalls()).toBe(pendingRequests);
          await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        }
      }
      if (restartHost) {
        await expectChildInterruptedByRestart({
          approvalName,
          child,
          outputPath,
          provider,
          root,
          userDataDir: electron.getUserDataDir(),
        });
      } else if (decision === 'Stop') {
        await child.getByRole('button', { exact: true, name: 'Stop' }).click();
        await expect(
          child.getByRole('button', { exact: true, name: approvalName })
        ).not.toBeVisible();
        await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        // The tab ✕ is a mouse-only, aria-hidden sibling of the tab that shows on
        // hover (TabStrip contract), so point at the tab first.
        await window.getByRole('tab', { exact: true, name: childName }).hover();
        await window
          .getByRole('button', { exact: true, includeHidden: true, name: `Close ${childName}` })
          .click();
        // A cancelled background child wakes its parent once, as the shipped
        // assistant did (packages/agent/src/mastra/background-idle-loop.ts:38-46 on
        // main ed97957e0); that turn settles before the next answer is scripted.
        const stoppedRuns = [
          { outcome: 'completed', states: [], via: 'command' },
          { outcome: 'completed', states: ['cancelled'], via: 'wake' },
        ];
        await expect
          .poll(() => rootRuns(electron.getUserDataDir()), { timeout: 30_000 })
          .toEqual(stoppedRuns);
        provider.setScript({ finalText: 'PARENT_REMAINS_USABLE_AFTER_CHILD_STOP_1723' });
        await root
          .getByRole('textbox', { name: 'Message input' })
          .fill('Continue after stopping that child.');
        await root.getByRole('button', { exact: true, name: 'Send' }).click();
        await expect(
          root.getByText('PARENT_REMAINS_USABLE_AFTER_CHILD_STOP_1723', { exact: true })
        ).toBeVisible();
        await expect(root.getByRole('button', { exact: true, name: 'Send' })).toBeVisible();
        // The user's turn carries no second delivery of the stopped child.
        await expect
          .poll(() => rootRuns(electron.getUserDataDir()))
          .toEqual([...stoppedRuns, { outcome: 'completed', states: [], via: 'command' }]);
        const afterStop = modelCalls();
        await window.reload();
        await ensureAssistantShellVisible(window);
        await root.getByRole('button', { exact: true, name: 'Expand activity' }).first().click();
        const reopen = root.getByRole('button', { name: /Open .* conversation/ }).first();
        await expect(reopen).toBeVisible();
        await reopen.click();
        await expect(selectedTab).toHaveText(childName);
        await expect(
          child.getByRole('button', { exact: true, name: approvalName })
        ).not.toBeVisible();
        // The host committed the child's run as stopped.
        await expect.poll(() => childOutcomes(electron.getUserDataDir())).toEqual(['stopped']);
        expect(modelCalls()).toBe(afterStop);
        await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        if (!autoApprove) {
          await child.getByRole('button', { name: 'Review 1 pending approval' }).click();
          const review = window.getByRole('dialog', { name: 'Pending approvals' });
          await expect(review.getByTestId('approval-delegation-owner')).toHaveText(childName);
          await review
            .getByRole('button', {
              exact: true,
              name: `${decision} brainstrike.writeWorkspaceFile`,
            })
            .click();
          await review.getByRole('button', { name: 'Close pending approvals' }).click();
        }
        await expect(child.getByText(childResult, { exact: true })).toBeVisible();
        await expect(root.getByText(parentResult, { exact: true })).toBeVisible();
        if (!autoApprove) {
          // Both views retain the chronological request, but neither may offer
          // a second decision after the leaf has finished.
          for (const panel of [root, child]) {
            await expect(
              panel.getByRole('button', { disabled: false, exact: true, name: approvalName })
            ).toHaveCount(0);
            await expect(panel.getByTestId('approval-queue-strip')).toHaveCount(0);
          }
        }
        expect(observed).toEqual({
          backgroundStarted: true,
          parentResult: true,
          writeResult: decision === 'Approve',
        });
        expect(
          provider
            .transcript()
            .filter((entry) => entry.decision === 'tool:brainstrike_writeWorkspaceFile')
        ).toHaveLength(1);
        // The write's recorded edit belongs to the child that made it, in that child's own run.
        const checkpoints = (await readHostThreadTree(electron.getUserDataDir())).flatMap(
          ({ child: listed, rows }) => {
            const runIds = new Set(
              rows.flatMap(({ event }) => (event.type === 'run.started' ? [event.runId] : []))
            );
            return rows.flatMap(({ event }) =>
              event.type === 'workspace.edit.recorded' && event.path === 'worker-output.txt'
                ? [{ childName: listed?.callSign ?? null, owned: runIds.has(event.runId) }]
                : []
            );
          }
        );
        expect(checkpoints).toEqual(decision === 'Approve' ? [{ childName, owned: true }] : []);
        if (autoApprove) {
          await expect(window.getByTestId('child-workspace-mode')).toContainText(
            path.basename(workspace)
          );
          // The child's composer names the same shared folder, read-only: no picker.
          await expect(child.getByTestId('workspace-bar-shared-folder')).toHaveText(
            `Shared workspace: ${path.basename(workspace)}`
          );
          await expect(child.getByTestId('workspace-bar-folder-chip')).toHaveCount(0);
          await ensureActivityExpanded(child);
          await expect(child.getByTestId('checkpoint-revert')).toBeVisible();
        }
        const completedRequests = modelCalls();
        let writtenMtime: number | undefined;
        if (decision === 'Approve') {
          expect(await readFile(outputPath, 'utf8')).toBe(content);
          writtenMtime = (await stat(outputPath)).mtimeMs;
        } else {
          await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        }
        await window.getByRole('tab', { exact: true, name: childName }).hover();
        await window
          .getByRole('button', { exact: true, includeHidden: true, name: `Close ${childName}` })
          .click();
        await expect(root.getByText(parentResult, { exact: true })).toBeVisible();
        await window.reload();
        await ensureAssistantShellVisible(window);
        await expect(root.getByText(parentResult, { exact: true })).toBeVisible();
        expect(modelCalls()).toBe(completedRequests);
        if (decision === 'Approve') {
          expect(await readFile(outputPath, 'utf8')).toBe(content);
          expect((await stat(outputPath)).mtimeMs).toBe(writtenMtime);
        } else {
          await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        }
        if (depth === 3) {
          // Mixed foreground/background siblings retain distinct shared-workspace identities.
          provider.setScript(({ messages }) => {
            const task = JSON.stringify(
              messages.filter(
                (message) =>
                  message &&
                  typeof message === 'object' &&
                  'role' in message &&
                  message.role === 'user'
              )
            );
            return task.includes('SECOND_SIBLING_TASK_1725')
              ? {
                  finalText: 'SECOND_CHILD_READ_1725',
                  toolCall: {
                    arguments: { path: 'worker-output.txt' },
                    name: 'brainstrike_readWorkspaceFile',
                  },
                }
              : {
                  finalText: 'SECOND_CHILD_PARENT_RESULT_1725',
                  toolCall: {
                    arguments: {
                      _background: { enabled: false },
                      prompt:
                        'SECOND_SIBLING_TASK_1725: read worker-output.txt and report its contents.',
                    },
                    name: 'agent-worker',
                  },
                };
          });
          await root
            .getByRole('textbox', { name: 'Message input' })
            .fill('START_SECOND_CHILD_1725: delegate another Worker to inspect the deliverable.');
          await root.getByRole('button', { exact: true, name: 'Send' }).click();
          await expect(
            root.getByText('SECOND_CHILD_PARENT_RESULT_1725', { exact: true })
          ).toBeVisible();
          await root.getByRole('button', { exact: true, name: 'Expand activity' }).last().click();
          await root
            .getByRole('button', { name: /Open .* conversation/ })
            .last()
            .click();
          await expect(selectedTab).toHaveText(/^[A-Z][a-z]+-[a-f0-9]{6}$/);
          const secondName = (await selectedTab.innerText()).trim();
          expect(secondName).not.toBe(firstChildName);
          await expect(
            window
              .getByRole('region', { exact: true, name: secondName })
              .getByText('SECOND_CHILD_READ_1725', { exact: true })
          ).toBeVisible();
          const afterSecond = modelCalls();
          await window.getByRole('tab', { exact: true, name: secondName }).hover();
          await window
            .getByRole('button', { exact: true, includeHidden: true, name: `Close ${secondName}` })
            .click();
          await root
            .getByRole('button', { name: /Open .* conversation/ })
            .last()
            .click();
          await expect(selectedTab).toHaveText(secondName);
          await window.reload();
          await ensureAssistantShellVisible(window);
          await expect(selectedTab).toHaveText(secondName);
          await expect(
            window.getByRole('tab', { exact: true, name: firstChildName })
          ).toBeVisible();
          expect(modelCalls()).toBe(afterSecond);
          expect((await stat(outputPath)).mtimeMs).toBe(writtenMtime);
        }
        if (autoApprove) {
          await ensureActivityExpanded(root);
          await root.getByRole('button', { name: /Open .* conversation/ }).click();
          await expect(selectedTab).toHaveText(childName);
          await expect(child.getByText(childResult, { exact: true })).toBeVisible();
          await ensureActivityExpanded(child);
          const requestsBeforeRestore = modelCalls();
          const userPath = path.join(workspace, 'user-note.txt');
          await writeFile(userPath, 'Independent user edit\n');
          await child.getByTestId('checkpoint-revert').click();
          await child.getByRole('button', { exact: true, name: 'Confirm restore' }).click();
          await expect(child.getByTestId('checkpoint-reverted')).toBeVisible();
          await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(userPath, 'utf8')).toBe('Independent user edit\n');
          await window.reload();
          await ensureAssistantShellVisible(window);
          await expect(child.getByText(childResult, { exact: true })).toBeVisible();
          await ensureActivityExpanded(child);
          await expect(child.getByTestId('checkpoint-reverted')).toBeVisible();
          expect(modelCalls()).toBe(requestsBeforeRestore);
        }
      }
      await window.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath('worker-write-result.png'),
      });
    } catch (error) {
      failures.push(error);
      for (const attach of [
        async () => window.screenshot({ path: testInfo.outputPath('worker-write-failure.png') }),
        async () =>
          writeFile(
            testInfo.outputPath('worker-write-failure.txt'),
            await window.locator('body').innerText()
          ),
        async () =>
          writeFile(
            testInfo.outputPath('worker-host-tree-diagnostic.json'),
            JSON.stringify(await readHostThreadTree(electron.getUserDataDir()), null, 2)
          ),
        async () =>
          testInfo.attach('worker-write-failure', {
            body: await window.locator('body').innerText(),
            contentType: 'text/plain',
          }),
        async () =>
          testInfo.attach('worker-provider-transcript', {
            body: JSON.stringify(provider.transcript()),
            contentType: 'application/json',
          }),
      ]) {
        try {
          await attach();
        } catch (attachmentError) {
          failures.push(attachmentError);
        }
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    // Every owner is released, even when an earlier teardown rejects. Keep
    // the acceptance failure first rather than replacing it with diagnostics.
    for (const cleanup of [
      async () => {
        await Promise.all([waitForOwnedExit(ownedProcess), electron.dispose()]);
        if (ownedProcess) {
          // Soft: a clean exit is required, but its failure never hides the body's.
          expect.soft(ownedProcess.exitCode).toBe(0);
          expect.soft(ownedProcess.signalCode).toBeNull();
        }
      },
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
      async () => rm(workspace, { force: true, recursive: true }),
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
    throw new AggregateError(failures, 'Worker acceptance and fixture cleanup failed', {
      cause: failures[0],
    });
  }
}
