import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

// A new, previously absent file is deliberately used: runWriteWorkspaceFile's
// staleness guard permits new/unobserved files. Existing-file edit acceptance
// must read first; this case does not manufacture a read failure for a new file.
for (const decision of ['Approve', 'Decline'] as const) {
  test(`worker ${decision} controls a reloaded disposable workspace write @smoke`, async ({
    electron,
  }, testInfo) => {
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
    const observed = { parentResult: false, writeResult: false };
    const provider = await startModelProviderShim(({ toolNames, messages }) => {
      const history = JSON.stringify(messages);
      const isParent = toolNames.includes('agent-explore');
      if (isParent) {
        resolveAdvertisedTools(toolNames);
        observed.parentResult ||= history.includes(childResult);
        return {
          finalText: parentResult,
          toolCall: {
            arguments: {
              prompt:
                'Create worker-output.txt with the requested disposable deliverable, then report the outcome.',
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
      const window = await electron.ensureWindow();
      try {
        await ensureMockWorkspaceOpen(window);
        await configureAssistantProvider(window, {
          compositeModelKey: 'openrouter::openai/gpt-5.4',
          provider: 'openrouter',
        });
        await new HomePage(window).openSettings();
        await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
        await window.getByTestId('permission-policy-edit').selectOption('ask');
        await window
          .getByRole('combobox', { exact: true, name: 'Read permission' })
          .selectOption('allow');
        await ensureAssistantShellVisible(window);
        const root = window.getByTestId('chat-panel');
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
        await expect(root.getByRole('button', { exact: true, name: approvalName })).toBeVisible();
        await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await root.getByRole('button', { exact: true, name: 'Expand activity' }).click();
        await root.getByRole('button', { name: /Open .* conversation/ }).click();
        const selectedTab = window
          .getByRole('tablist', { name: 'Workspace tabs' })
          .getByRole('tab', { selected: true });
        await expect(selectedTab).toHaveText(/^(Cedar|Fern|Aspen|Maple|Iris|Willow)-[a-f0-9]+$/);
        const childName = (await selectedTab.innerText()).trim();
        const child = window.getByRole('region', { exact: true, name: childName });
        await expect(child.getByRole('button', { exact: true, name: approvalName })).toBeVisible();
        const pendingRequests = provider.requestCount();
        await window.reload();
        await configureAssistantProvider(window, {
          compositeModelKey: 'openrouter::openai/gpt-5.4',
          provider: 'openrouter',
        });
        await ensureAssistantShellVisible(window);
        await expect(child.getByRole('button', { exact: true, name: approvalName })).toBeVisible();
        expect(provider.requestCount()).toBe(pendingRequests);
        await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await child
          .getByRole('button', { exact: true, name: `${decision} brainstrike.writeWorkspaceFile` })
          .click();
        await expect(child.getByText(childResult, { exact: true })).toBeVisible();
        await expect(root.getByText(parentResult, { exact: true })).toBeVisible();
        expect(observed).toEqual({ parentResult: true, writeResult: decision === 'Approve' });
        expect(
          provider
            .transcript()
            .filter((entry) => entry.decision === 'tool:brainstrike_writeWorkspaceFile')
        ).toHaveLength(1);
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
        await window.screenshot({
          animations: 'disabled',
          path: testInfo.outputPath('worker-write-result.png'),
        });
      } catch (error) {
        await testInfo.attach('worker-write-failure', {
          body: await window.locator('body').innerText(),
          contentType: 'text/plain',
        });
        await testInfo.attach('worker-provider-transcript', {
          body: JSON.stringify(provider.transcript()),
          contentType: 'application/json',
        });
        throw error;
      }
    } finally {
      await electron.dispose();
      await provider.close();
      for (const key of Object.keys(environment)) {
        const value = previous[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(workspace, { force: true, recursive: true });
    }
  });
}
