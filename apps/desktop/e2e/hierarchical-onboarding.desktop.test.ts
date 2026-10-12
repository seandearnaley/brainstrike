import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { launchElectronAppWithOptions } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

// Same tool shapes as the October 12 debug pack. The exact recall race is
// deterministic in child-pending-recall.integration; here all app owners run.
test('hierarchical research uses two supervisors and four Explorer leaves, creates a Canvas and omits empty thinking on reload', async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), 'bs-luna-tools-'));
  const workspace = path.join(profile, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'evidence.txt'), 'Recorded workspace evidence.');
  const rootId = randomUUID();
  const reply = 'Onboarding Canvas created from four Explorer reports.';
  const title = 'Hierarchical onboarding';
  const html = '<html><body><h1>Onboarding</h1><p>Four Explorer reports.</p></body></html>';
  let canvasLoaded = false;
  let canvasCreated = false;
  const provider = await startModelProviderShim(({ toolNames, messages }) => {
    const text = JSON.stringify(messages);
    const task = messages.findLast(
      (message) =>
        message && typeof message === 'object' && 'role' in message && message.role === 'user'
    );
    const prompt = JSON.stringify(task);
    const reasoning = { emptyResponsesReasoning: true as const };
    if (toolNames.length === 0) {
      return { ...reasoning, finalText: 'Onboarding' };
    }
    if (!toolNames.includes('agent-explore')) {
      // Leaf tools retain their read-only authority, with no onward delegation.
      expect(toolNames).not.toContain('agent-worker');
      expect(toolNames).not.toContain('brainstrike_writeWorkspaceFile');
      return {
        ...reasoning,
        finalText: 'Explorer evidence read.',
        toolCall: {
          arguments: { path: 'evidence.txt', root: rootId },
          name: 'brainstrike_readWorkspaceFile',
        },
      };
    }
    if (text.includes('Background invocations of this turn')) {
      if (!canvasLoaded) {
        canvasLoaded = true;
        return {
          ...reasoning,
          finalText: reply,
          ignorePriorToolResults: true,
          toolCall: { arguments: { toolName: 'brainstrike_manageCanvas' }, name: 'load_tool' },
        };
      }
      if (!canvasCreated) {
        expect(toolNames).toContain('brainstrike_manageCanvas');
        canvasCreated = true;
        return {
          ...reasoning,
          finalText: reply,
          ignorePriorToolResults: true,
          toolCall: {
            arguments: { action: 'create', html, title },
            name: 'brainstrike_manageCanvas',
          },
        };
      }
      return { ...reasoning, finalText: reply };
    }
    if (prompt.includes('SUPERVISOR_TASK')) {
      return {
        ...reasoning,
        finalText: 'Supervisor reviewed both Explorer reports.',
        toolCalls: ['a', 'b'].map((area) => ({
          arguments: {
            _background: { enabled: false },
            prompt: `LEAF_TASK ${area}: read evidence.txt and report findings.`,
          },
          name: 'agent-explore',
        })),
      };
    }
    expect(toolNames).toContain('agent-worker');
    return {
      ...reasoning,
      finalText: 'Waiting for supervisors.',
      toolCalls: ['product', 'platform'].map((area) => ({
        arguments: {
          _background: { enabled: true },
          prompt: `SUPERVISOR_TASK ${area}: delegate two Explorer leaves to read evidence.txt; report findings, make no edits.`,
        },
        name: 'agent-worker',
      })),
    };
  });
  let joined = false;
  const server = await createServer({
    configFile: path.resolve('vite.config.mts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const rendererUrl = server.resolvedUrls?.local[0];
    if (!rendererUrl) {
      throw new Error('Dev renderer URL unavailable');
    }
    const context = await launchElectronAppWithOptions({
      disableExternalLocalRuntimeProbes: true,
      env: { ['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']: rendererUrl },
      launchMode: 'dev-server',
      modelProvider: provider,
      userDataDir: profile,
      workspaceRoot: workspace,
    });
    const child = context.app.process();
    try {
      const page = context.window;
      await expect(page.getByTestId('new-agent-button')).toBeVisible();
      await seedRoot(page, workspace, {
        disableBackgroundIndexing: true,
        reloadReason: 'luna-tools',
        rootId,
      });
      await configureAssistantProvider(page, {
        apiKey: 'test-key-luna-tools',
        compositeModelKey: 'openai::gpt-6-luna',
        provider: 'openai',
      });
      await ensureAssistantShellVisible(page);
      const region = page.getByRole('region', { exact: true, name: 'Assistant' });
      await region
        .getByRole('textbox', { name: 'Message input' })
        .fill(
          'Use two supervisors with two Explorer children each, then create an onboarding Canvas.'
        );
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
      const approve = region.getByRole('button', {
        exact: true,
        name: 'Approve brainstrike.manageCanvas',
      });
      await expect(approve).toBeVisible();
      await approve.click();
      await expect(region.getByText(reply, { exact: true }).first()).toBeVisible();
      const tree = await readHostThreadTree(profile);
      const root = tree.find(({ parentThreadId }) => parentThreadId === undefined);
      expect(root).toBeDefined();
      const supervisors = tree.filter(({ parentThreadId }) => parentThreadId === root?.threadId);
      expect(supervisors).toHaveLength(2);
      for (const supervisor of supervisors) {
        expect(
          tree.filter(({ parentThreadId }) => parentThreadId === supervisor.threadId)
        ).toHaveLength(2);
      }
      expect(tree).toHaveLength(7);
      for (const thread of tree) {
        expect(
          thread.rows.findLast(({ event }) => event.type === 'run.finished')?.event
        ).toMatchObject({ outcome: 'completed' });
      }
      expect(
        root?.rows.flatMap(({ event }) =>
          event.type === 'tool.state.updated' && event.key.startsWith('brainstrike.manageCanvas/')
            ? [event.value]
            : []
        )
      ).toMatchObject([{ html, title, version: 1 }]);
      // Prove empty reasoning was committed, then omitted only from the visible transcript.
      expect(JSON.stringify(tree)).toContain('opaque-fixture-state');
      await expect(region.getByTestId('local-chain-of-thought')).toHaveCount(0);
      await page.reload();
      await expect(region.getByText(reply, { exact: true }).first()).toBeVisible();
      await expect(region.getByTestId('local-chain-of-thought')).toHaveCount(0);
      expect(provider.refusals()).toEqual([]);
      await testInfo.attach('committed-thread-tree', {
        body: JSON.stringify(tree, null, 2),
        contentType: 'application/json',
      });
    } catch (error) {
      await testInfo.attach('failed-host-tree', {
        body: JSON.stringify(await readHostThreadTree(profile), null, 2),
        contentType: 'application/json',
      });
      await testInfo.attach('provider-transcript', {
        body: JSON.stringify(provider.transcript(), null, 2),
        contentType: 'application/json',
      });
      await testInfo.attach('app-text', {
        body: await context.window.locator('body').innerText(),
        contentType: 'text/plain',
      });
      throw error;
    } finally {
      await context.app.close();
      joined = true;
      expect(child.exitCode).toBe(0);
    }
  } finally {
    await server.close();
    await provider.close();
    if (joined) {
      await rm(profile, { force: true, recursive: true });
    }
  }
});
