// Keep foreground decisions covered explicitly; delegated-worker-write covers background mode.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

// Script only the external model provider. Assistant HTTP, native permission,
// delegation, workspace reads, persistence and shared child controls are real.
test('approves the exact reloaded child through the shared workspace @smoke', async ({
  electron,
}, testInfo) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-child-control-'));
  await writeFile(path.join(workspace, 'evidence.txt'), 'CHILD_EVIDENCE_1720');
  const observed = { childRead: false, parentResult: false };
  const provider = await startModelProviderShim(({ messages }) => {
    // Children now advertise delegation too; identify the actual root task.
    const isParent = JSON.stringify(
      messages
        .filter(
          (message) =>
            message && typeof message === 'object' && 'role' in message && message.role === 'user'
        )
        .at(-1)
    ).includes('Delegate to Explorer to read evidence.txt.');
    const history = JSON.stringify(messages);
    if (isParent && history.includes('CHILD_READ_COMPLETE_1720')) {
      observed.parentResult = true;
    }
    if (!isParent && history.includes('CHILD_EVIDENCE_1720')) {
      observed.childRead = true;
    }
    return isParent
      ? {
          finalText: 'PARENT_RECEIVED_CHILD_1720',
          toolCall: {
            arguments: {
              _background: { enabled: false },
              prompt: 'Read evidence.txt and report its marker.',
            },
            name: 'agent-explore',
          },
        }
      : {
          finalText: 'CHILD_READ_COMPLETE_1720',
          toolCall: { arguments: { path: 'evidence.txt' }, name: 'brainstrike_readWorkspaceFile' },
        };
  });
  const previousUrl = process.env['OPENROUTER_BASE_URL'];
  const previousKey = process.env['BRAINSTRIKE_OPENROUTER_API_KEY'];
  const previousRoot = process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'];
  process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = workspace;
  process.env['OPENROUTER_BASE_URL'] = provider.baseUrl;
  process.env['BRAINSTRIKE_OPENROUTER_API_KEY'] = 'isolated-child-provider-key';
  try {
    const window = await electron.ensureWindow();
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window, {
      compositeModelKey: 'openrouter::openai/gpt-5.4',
      provider: 'openrouter',
    });
    await new HomePage(window).openSettings();
    await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
    await window
      .getByRole('combobox', { exact: true, name: 'Read permission' })
      .selectOption('ask');
    await ensureAssistantShellVisible(window);
    const root = window.getByTestId('chat-panel');
    await root
      .getByRole('textbox', { name: 'Message input' })
      .fill('Delegate to Explorer to read evidence.txt.');
    await root.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(
      root.getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
    ).toBeVisible();
    await root.getByRole('button', { exact: true, name: 'Expand activity' }).click();
    const openChild = root.getByRole('button', { name: /Open .* conversation/ });
    await expect(openChild).toBeVisible();
    await openChild.click();
    const childTab = window
      .getByRole('tablist', { name: 'Workspace tabs' })
      .getByRole('tab', { selected: true });
    await expect(childTab).toHaveText(/^(Cedar|Fern|Aspen|Maple|Iris|Willow)-[a-f0-9]+$/);
    const childName = (await childTab.innerText()).trim();
    const child = window.getByRole('region', { exact: true, name: childName });
    await expect(
      child.getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
    ).toBeVisible();
    const pausedRequests = provider.requestCount();
    await window.reload();
    await configureAssistantProvider(window, {
      compositeModelKey: 'openrouter::openai/gpt-5.4',
      provider: 'openrouter',
    });
    await ensureAssistantShellVisible(window);
    await expect(
      child.getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
    ).toBeVisible();
    expect(provider.requestCount()).toBe(pausedRequests);
    await child
      .getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
      .click();
    await expect(child.getByText('CHILD_READ_COMPLETE_1720', { exact: true })).toBeVisible();
    await expect(root.getByText('PARENT_RECEIVED_CHILD_1720', { exact: true })).toBeVisible();
    expect(observed).toEqual({ childRead: true, parentResult: true });
    const completedRequests = provider.requestCount();
    const closeChild = window.getByRole('button', {
      name: /^Close (Cedar|Fern|Aspen|Maple|Iris|Willow)-/,
    });
    await closeChild.click();
    await testInfo.attach('activity-before-reopen', {
      body: await root.innerText(),
      contentType: 'text/plain',
    });
    const delegationGroup = root
      .getByTestId('assistant-activity-group')
      .filter({ hasText: 'Explorer' })
      .last();
    await delegationGroup.getByRole('button', { exact: true, name: 'Expand activity' }).click();
    await testInfo.attach('activity-after-expand', {
      body: await root.innerText(),
      contentType: 'text/plain',
    });
    await delegationGroup.getByRole('button', { name: /Open .* conversation/ }).click();
    await expect(child.getByText('CHILD_READ_COMPLETE_1720', { exact: true })).toBeVisible();
    expect(provider.requestCount()).toBe(completedRequests);
    const geometry = await child.boundingBox();
    expect(geometry).not.toBeNull();
    expect(geometry?.width).toBeGreaterThan(200);
    expect(geometry?.height).toBeGreaterThan(200);
    await window.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('real-child-control.png'),
    });
  } finally {
    await electron.dispose();
    await provider.close();
    if (previousUrl === undefined) {
      delete process.env['OPENROUTER_BASE_URL'];
    } else {
      process.env['OPENROUTER_BASE_URL'] = previousUrl;
    }
    if (previousKey === undefined) {
      delete process.env['BRAINSTRIKE_OPENROUTER_API_KEY'];
    } else {
      process.env['BRAINSTRIKE_OPENROUTER_API_KEY'] = previousKey;
    }
    if (previousRoot === undefined) {
      delete process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'];
    } else {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = previousRoot;
    }
    await rm(workspace, { force: true, recursive: true });
  }
});
