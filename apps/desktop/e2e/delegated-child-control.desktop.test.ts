import { once } from 'node:events';
// Keep foreground decisions covered explicitly; delegated-worker-write covers background mode.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const executedConfigurations: { isParent: boolean; body: unknown }[] = [];
  const provider = await startModelProviderShim(({ messages, toolNames, requestBody }) => {
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
    if (toolNames.length > 0) {
      executedConfigurations.push({ body: requestBody, isParent });
    }
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
    await root.getByTestId('composer-effort-trigger').click();
    await window.getByRole('slider', { name: 'Reasoning effort' }).press('End');
    await window.keyboard.press('Escape');
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
    const firstChild = executedConfigurations.find((entry) => !entry.isParent);
    expect(firstChild?.body).toMatchObject({
      model: 'openai/gpt-5.4',
      reasoning: { effort: 'xhigh' },
    });
    // Change the parent's actual model control while its child decision is pending.
    await root.getByTestId('composer-model-menu-trigger').click();
    const modelDialog = window.getByRole('dialog', { name: 'Choose a model' });
    await modelDialog.getByRole('combobox').fill('GPT-5.6 Terra');
    const terra = modelDialog
      .getByRole('option', { name: /^GPT-5\.6 Terra/u })
      .filter({ hasText: 'OpenRouter' });
    await expect(terra).toBeVisible();
    await terra.click();
    await expect(root.getByTestId('composer-model-menu-trigger')).toContainText('GPT-5.6 Terra');
    const pausedRequests = provider.requestCount();
    await window.reload();
    await configureAssistantProvider(window, {
      compositeModelKey: 'openrouter::openai/gpt-5.6-terra',
      provider: 'openrouter',
    });
    await ensureAssistantShellVisible(window);
    await expect(
      child.getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
    ).toBeVisible();
    expect(provider.requestCount()).toBe(pausedRequests);
    // The recreated sidebar must recover the same native pending decision without
    // relying on a live-stream publication from before the renderer reload.
    const sidebarRoot = window
      .getByRole('row')
      .filter({ has: window.getByTestId('thread-row') })
      .first();
    await sidebarRoot.getByRole('button', { name: /Expand/u }).click();
    const pendingSidebarChild = window.getByRole('button', {
      exact: true,
      name: `${childName} Needs input`,
    });
    await expect(pendingSidebarChild).toBeVisible();
    expect(provider.requestCount()).toBe(pausedRequests);
    await child
      .getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
      .click();
    await expect(child.getByText('CHILD_READ_COMPLETE_1720', { exact: true })).toBeVisible();
    await expect(root.getByText('PARENT_RECEIVED_CHILD_1720', { exact: true })).toBeVisible();
    expect(observed).toEqual({ childRead: true, parentResult: true });
    const childExecutions = executedConfigurations.filter((entry) => !entry.isParent);
    expect(childExecutions).toHaveLength(2);
    expect(childExecutions[1]?.body).toMatchObject({
      model: 'openai/gpt-5.4',
      reasoning: { effort: 'xhigh' },
    });
    expect(executedConfigurations.filter((entry) => entry.isParent).at(-1)?.body).toMatchObject({
      model: 'openai/gpt-5.6-terra',
    });
    await expect(child.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
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
    await expect(child.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
    const geometry = await child.boundingBox();
    expect(geometry).not.toBeNull();
    expect(geometry?.width).toBeGreaterThan(200);
    expect(geometry?.height).toBeGreaterThan(200);
    await window.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('real-child-control.png'),
    });
  } finally {
    try {
      const ownedProcess = (await electron.ensureContext()).app.process();
      await Promise.all([
        once(ownedProcess, 'exit', { signal: AbortSignal.timeout(5000) }),
        electron.dispose(),
      ]);
      expect(ownedProcess.exitCode).toBe(0);
      expect(ownedProcess.signalCode).toBeNull();
    } finally {
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
  }
});

// Regression project (not @smoke): the PR smoke lane's 720s global budget is
// already consumed by the 43 smoke cases on main, and this case adds a full
// app launch plus a reload. It runs in the scheduled full-regression lane.
test('sends human input to the active child and reloads its rich conversation', async ({
  electron,
}, testInfo) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-child-input-'));
  await writeFile(path.join(workspace, 'evidence.txt'), 'FOLLOWUP_FILE_EVIDENCE');
  await writeFile(path.join(workspace, 'context.txt'), 'CHILD_MENTION_CONTEXT_1724');
  await mkdir(path.join(workspace, '.brainstrike', 'commands'), { recursive: true });
  await writeFile(
    path.join(workspace, '.brainstrike', 'commands', 'child-evidence.md'),
    'HUMAN_FOLLOWUP_1723\n\n@context.txt'
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let childCalls = 0;
  const childGenerationRequests: unknown[] = [];
  let receivedInput = false;
  let receivedImage = false;
  let receivedFileContext = false;
  const imageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGAAAAEEAIFw9selAAAAAElFTkSuQmCC',
    'base64'
  );
  const imageMarker = imageBytes.toString('base64');
  const provider = await startModelProviderShim(({ messages, toolNames, requestBody }) => {
    if (toolNames.length === 0) {
      return { finalText: 'Child input task' };
    }
    const history = JSON.stringify(messages);
    const userMessages = JSON.stringify(
      messages.filter(
        (message) =>
          message && typeof message === 'object' && 'role' in message && message.role === 'user'
      )
    );
    if (!userMessages.includes('CHILD_ACTIVE_INPUT_TASK')) {
      if (history.includes('CHILD_IDLE_APPROVAL_COMPLETE')) {
        return { finalText: 'PARENT_IDLE_APPROVAL_OUTCOME' };
      }
      if (history.includes('CHILD_IDLE_CONTINUATION_RECEIVED')) {
        return { finalText: 'PARENT_IDLE_CONTINUATION_OUTCOME' };
      }
      if (history.includes('CHILD_FOLLOWUP_RECEIVED')) {
        return { finalText: 'PARENT_FOLLOWUP_OUTCOME' };
      }
      if (history.includes('Background task started.')) {
        return { finalText: 'Parent continues while the child reads.' };
      }
      return {
        finalText: 'Parent continues while the child reads.',
        toolCall: {
          arguments: {
            _background: { enabled: true },
            prompt: 'CHILD_ACTIVE_INPUT_TASK: read evidence.txt and report its marker.',
          },
          name: 'agent-explore',
        },
      };
    }
    childCalls += 1;
    childGenerationRequests.push(requestBody);
    if (childCalls === 1) {
      entered.resolve();
    }
    if (history.includes('HUMAN_IDLE_APPROVAL_1723')) {
      return {
        finalText: 'CHILD_IDLE_APPROVAL_COMPLETE',
        toolCall: { arguments: { path: 'evidence.txt' }, name: 'brainstrike_readWorkspaceFile' },
      };
    }
    if (childCalls === 3 && history.includes(imageMarker)) {
      return { finalText: 'CHILD_IDLE_CONTINUATION_RECEIVED' };
    }
    if (history.includes('HUMAN_FOLLOWUP_1723')) {
      receivedInput = true;
      receivedImage = history.includes(imageMarker);
      receivedFileContext = messages.some(
        (message) =>
          message &&
          typeof message === 'object' &&
          'role' in message &&
          message.role === 'system' &&
          JSON.stringify(message).includes('CHILD_MENTION_CONTEXT_1724')
      );
      return { finalText: 'CHILD_FOLLOWUP_RECEIVED' };
    }
    return {
      ...(childCalls === 1 ? { beforeToolFinish: release.promise } : {}),
      finalText: 'CHILD_MISSED_INPUT',
      toolCall: { arguments: { path: 'evidence.txt' }, name: 'brainstrike_readWorkspaceFile' },
    };
  });
  const environment = {
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: 'isolated-child-input-key',
    OPENROUTER_BASE_URL: provider.baseUrl,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
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
      .selectOption('allow');
    await ensureAssistantShellVisible(window);
    const root = window.getByTestId('chat-panel');
    await root
      .getByRole('textbox', { name: 'Message input' })
      .fill('ROOT_ACTIVE_INPUT_TASK: delegate to Explorer to read evidence.txt.');
    await root.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect.poll(() => childCalls).toBeGreaterThan(0);
    await entered.promise;
    await expect(
      root.getByText('Parent continues while the child reads.', { exact: true })
    ).toBeVisible();
    await root.getByRole('button', { exact: true, name: 'Expand activity' }).first().click();
    await root.getByRole('button', { name: /Open .* conversation/ }).click();
    const childTab = window
      .getByRole('tablist', { name: 'Workspace tabs' })
      .getByRole('tab', { selected: true });
    await expect(childTab).toHaveText(/^(Cedar|Fern|Aspen|Maple|Iris|Willow)-[a-f0-9]+$/);
    const childName = (await childTab.innerText()).trim();
    const child = window.getByRole('region', { exact: true, name: childName });
    const input = child.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeEnabled();
    await input.fill('/child-evidence');
    await child.getByRole('option', { exact: true, name: 'child-evidence' }).click();
    await expect(input).toHaveValue(/HUMAN_FOLLOWUP_1723/u);
    await expect(input).toHaveValue(/:file\[context\.txt\]/u);
    const activeChooser = window.waitForEvent('filechooser');
    await child.getByRole('button', { exact: true, name: 'Attach image' }).click();
    await (await activeChooser).setFiles({
      buffer: imageBytes,
      mimeType: 'image/png',
      name: 'evidence.png',
    });
    await child.getByRole('button', { exact: true, name: 'Send to child' }).click();
    await expect(input).toHaveValue('');
    release.resolve();
    await expect(child.getByText('HUMAN_FOLLOWUP_1723', { exact: true })).toBeVisible();
    await expect(child.getByText('CHILD_FOLLOWUP_RECEIVED', { exact: true })).toBeVisible();
    await expect(root.getByText('PARENT_FOLLOWUP_OUTCOME', { exact: true })).toBeVisible();
    expect(receivedInput).toBe(true);
    expect(receivedImage).toBe(true);
    expect(receivedFileContext).toBe(true);
    await expect(child.locator('img[src^="data:image/png"]')).toHaveCount(1);
    expect(childCalls).toBe(2);
    const completedRequests = provider.requestCount();
    await window.reload();
    await ensureAssistantShellVisible(window);
    await expect(child.getByText('HUMAN_FOLLOWUP_1723', { exact: true })).toBeVisible();
    await expect(child.getByText('CHILD_FOLLOWUP_RECEIVED', { exact: true })).toBeVisible();
    expect(provider.requestCount()).toBe(completedRequests);
    await expect(input).toBeEnabled();
    await child.getByTestId('composer-effort-trigger').click();
    await window.getByRole('slider', { name: 'Reasoning effort' }).press('End');
    await window.keyboard.press('Escape');
    await expect(child.getByTestId('composer-effort-trigger')).toContainText('Extra');
    const idleChooser = window.waitForEvent('filechooser');
    await child.getByRole('button', { exact: true, name: 'Attach image' }).click();
    await (await idleChooser).setFiles({
      buffer: imageBytes,
      mimeType: 'image/png',
      name: 'idle-evidence.png',
    });
    await child.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(input).toHaveValue('');
    await expect(child.locator('img[src^="data:image/png"]')).toHaveCount(2);
    await expect(
      child.getByText('CHILD_IDLE_CONTINUATION_RECEIVED', { exact: true })
    ).toBeVisible();
    await expect(root.getByText('PARENT_IDLE_CONTINUATION_OUTCOME', { exact: true })).toBeVisible();
    expect(childCalls).toBe(3);
    expect(childGenerationRequests[2]).toMatchObject({ reasoning: { effort: 'xhigh' } });
    const continuedRequests = provider.requestCount();
    await window.reload();
    await ensureAssistantShellVisible(window);
    await expect(child.locator('img[src^="data:image/png"]')).toHaveCount(2);
    await expect(
      child.getByText('CHILD_IDLE_CONTINUATION_RECEIVED', { exact: true })
    ).toBeVisible();
    expect(provider.requestCount()).toBe(continuedRequests);
    await new HomePage(window).openSettings();
    await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
    await window
      .getByRole('combobox', { exact: true, name: 'Read permission' })
      .selectOption('ask');
    await ensureAssistantShellVisible(window);
    await child.getByTestId('composer-effort-trigger').click();
    await window.getByRole('slider', { name: 'Reasoning effort' }).press('End');
    await window.keyboard.press('Escape');
    await input.fill('HUMAN_IDLE_APPROVAL_1723');
    await child.getByRole('button', { exact: true, name: 'Send' }).click();
    const approve = child.getByRole('button', {
      exact: true,
      name: 'Approve brainstrike.readWorkspaceFile',
    });
    await expect(approve).toBeVisible();
    expect(childCalls).toBe(4);
    expect(childGenerationRequests[3]).toMatchObject({ reasoning: { effort: 'xhigh' } });
    // A draft for a future child run must not mutate the suspended invocation.
    await child.getByTestId('composer-effort-trigger').click();
    await window.getByRole('slider', { name: 'Reasoning effort' }).press('Home');
    await window.keyboard.press('Escape');
    const suspendedRequests = provider.requestCount();
    await window.reload();
    await ensureAssistantShellVisible(window);
    await expect(approve).toBeVisible();
    expect(provider.requestCount()).toBe(suspendedRequests);
    await approve.click();
    await expect(child.getByText('CHILD_IDLE_APPROVAL_COMPLETE', { exact: true })).toBeVisible();
    await expect(root.getByText('PARENT_IDLE_APPROVAL_OUTCOME', { exact: true })).toBeVisible();
    expect(childCalls).toBe(5);
    expect(childGenerationRequests[4]).toMatchObject({ reasoning: { effort: 'xhigh' } });
    const approvedRequests = provider.requestCount();
    await window.reload();
    await ensureAssistantShellVisible(window);
    await expect(child.getByText('CHILD_IDLE_APPROVAL_COMPLETE', { exact: true })).toBeVisible();
    await expect(approve).toHaveCount(0);
    expect(provider.requestCount()).toBe(approvedRequests);
    await window.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('child-followup-reloaded.png'),
    });
  } finally {
    release.resolve();
    try {
      const process = (await electron.ensureContext()).app.process();
      const exited =
        process.exitCode === null && process.signalCode === null
          ? once(process, 'exit', { signal: AbortSignal.timeout(5000) })
          : Promise.resolve();
      await Promise.all([exited, electron.dispose()]);
      expect(process.exitCode).toBe(0);
      expect(process.signalCode).toBeNull();
    } finally {
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
  }
});
