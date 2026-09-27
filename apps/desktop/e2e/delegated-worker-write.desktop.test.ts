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
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

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

async function ensureActivityExpanded(region: Locator): Promise<void> {
  const expand = region.getByRole('button', { exact: true, name: 'Expand activity' });
  const collapse = region.getByRole('button', { exact: true, name: 'Collapse activity' });
  await expect(expand.or(collapse)).toBeVisible();
  if (await expand.count()) {
    await expand.click();
    return;
  }
  await expect(collapse).toBeVisible();
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
      await new HomePage(window).openSettings();
      await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
      await window
        .getByTestId('permission-policy-edit')
        .selectOption(autoApprove ? 'allow' : 'ask');
      await window
        .getByRole('combobox', { exact: true, name: 'Read permission' })
        .selectOption('allow');
      await ensureAssistantShellVisible(window);
      let root = window.getByTestId('chat-panel');
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
        await current.getByRole('button', { exact: true, name: 'Expand activity' }).click();
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
        const pendingRequests = provider.requestCount();
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
          root = window.getByTestId('chat-panel');
          child = window.getByRole('region', { exact: true, name: childName });
        } else {
          await window.reload();
        }
        await configureAssistantProvider(window, {
          compositeModelKey: 'openrouter::openai/gpt-5.4',
          provider: 'openrouter',
        });
        await ensureAssistantShellVisible(window);
        await expect(child.getByRole('button', { exact: true, name: approvalName })).toBeVisible();
        expect(provider.requestCount()).toBe(pendingRequests);
        await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      }
      if (decision === 'Stop') {
        await child.getByRole('button', { exact: true, name: 'Stop' }).click();
        await expect(
          child.getByRole('button', { exact: true, name: approvalName })
        ).not.toBeVisible();
        await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await window.getByRole('button', { exact: true, name: `Close ${childName}` }).click();
        provider.setScript({ finalText: 'PARENT_REMAINS_USABLE_AFTER_CHILD_STOP_1723' });
        await root
          .getByRole('textbox', { name: 'Message input' })
          .fill('Continue after stopping that child.');
        await root.getByRole('button', { exact: true, name: 'Send' }).click();
        await expect(
          root.getByText('PARENT_REMAINS_USABLE_AFTER_CHILD_STOP_1723', { exact: true })
        ).toBeVisible();
        await expect(root.getByRole('button', { exact: true, name: 'Send' })).toBeVisible();
        const afterStop = provider.requestCount();
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
        await expect
          .poll(async () =>
            window.evaluate(async () => {
              const api = (
                globalThis as {
                  electronAPI?: {
                    db?: { query?: (sql: string) => Promise<{ rows: { status: string }[] }> };
                  };
                }
              ).electronAPI;
              if (!api?.db?.query) {
                throw new Error('Missing database API');
              }
              return (
                await api.db.query(
                  'SELECT run.status FROM brainstrike_assistant_thread_runs run JOIN brainstrike_delegated_conversations child ON child.thread_id = run.thread_id WHERE child.parent_thread_id IS NOT NULL'
                )
              ).rows.map((row) => row.status);
            })
          )
          .toEqual(['cancelled']);
        expect(provider.requestCount()).toBe(afterStop);
        await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        if (!autoApprove) {
          await child
            .getByRole('button', {
              exact: true,
              name: `${decision} brainstrike.writeWorkspaceFile`,
            })
            .click();
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
        const checkpoints = await window.evaluate(async () => {
          const api = (
            globalThis as typeof globalThis & {
              electronAPI?: {
                db?: {
                  query?: (
                    sql: string
                  ) => Promise<{ rows: Array<{ childName: string | null; owned: boolean }> }>;
                };
              };
            }
          ).electronAPI;
          if (!api?.db?.query) {
            throw new Error('Native database bridge unavailable');
          }
          return (
            await api.db.query(`SELECT child.display_name AS "childName",
          (run.thread_id = checkpoint.thread_id AND run.resource_id = checkpoint.resource_id) AS owned
          FROM brainstrike_assistant_edit_checkpoints checkpoint
          JOIN brainstrike_assistant_thread_runs run ON run.id = checkpoint.run_id
          LEFT JOIN brainstrike_delegated_conversations child ON child.thread_id = checkpoint.thread_id
          WHERE checkpoint.path = 'worker-output.txt'`)
          ).rows;
        });
        expect(checkpoints).toEqual(decision === 'Approve' ? [{ childName, owned: true }] : []);
        if (autoApprove) {
          await expect(window.getByTestId('child-workspace-mode')).toContainText(
            path.basename(workspace)
          );
          await ensureActivityExpanded(child);
          await expect(child.getByTestId('checkpoint-revert')).toBeVisible();
        }
        const completedRequests = provider.requestCount();
        let writtenMtime: number | undefined;
        if (decision === 'Approve') {
          expect(await readFile(outputPath, 'utf8')).toBe(content);
          writtenMtime = (await stat(outputPath)).mtimeMs;
        } else {
          await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        }
        await window.getByRole('button', { exact: true, name: `Close ${childName}` }).click();
        await expect(root.getByText(parentResult, { exact: true })).toBeVisible();
        await window.reload();
        await ensureAssistantShellVisible(window);
        await expect(root.getByText(parentResult, { exact: true })).toBeVisible();
        expect(provider.requestCount()).toBe(completedRequests);
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
          const afterSecond = provider.requestCount();
          await window.getByRole('button', { exact: true, name: `Close ${secondName}` }).click();
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
          expect(provider.requestCount()).toBe(afterSecond);
          expect((await stat(outputPath)).mtimeMs).toBe(writtenMtime);
        }
        if (autoApprove) {
          await ensureActivityExpanded(root);
          await root.getByRole('button', { name: /Open .* conversation/ }).click();
          await expect(selectedTab).toHaveText(childName);
          await expect(child.getByText(childResult, { exact: true })).toBeVisible();
          await ensureActivityExpanded(child);
          const requestsBeforeRestore = provider.requestCount();
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
          expect(provider.requestCount()).toBe(requestsBeforeRestore);
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
        async () => {
          const state = await window.evaluate(async () => {
            const api = (
              globalThis as {
                electronAPI?: { db?: { query?: (sql: string) => Promise<{ rows: unknown[] }> } };
              }
            ).electronAPI;
            if (!api?.db?.query) {
              throw new Error('Missing diagnostic database API');
            }
            return {
              events: await api.db.query(
                'SELECT run_id, thread_id, kind, metadata, occurred_at FROM brainstrike_assistant_run_events ORDER BY occurred_at'
              ),
              messages: await api.db.query(
                'SELECT id, role, content, "createdAt", thread_id FROM mastra_messages ORDER BY "createdAt"'
              ),
              runs: await api.db.query(
                'SELECT id, thread_id, turn_message_id, status, started_at FROM brainstrike_assistant_thread_runs ORDER BY started_at'
              ),
            };
          });
          await writeFile(
            testInfo.outputPath('worker-database-diagnostic.json'),
            JSON.stringify(state, null, 2)
          );
        },
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
          expect(ownedProcess.exitCode).toBe(0);
          expect(ownedProcess.signalCode).toBeNull();
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
