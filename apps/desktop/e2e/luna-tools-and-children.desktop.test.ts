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
test('Luna loads eager tools, runs an extensionless skill and completes three Explorers across approval and reload', async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), 'bs-luna-tools-'));
  const workspace = path.join(profile, 'workspace');
  const scripts = path.join(workspace, '.brainstrike/skills/impeccable/scripts');
  await mkdir(scripts, { recursive: true });
  await writeFile(
    path.join(scripts, '../SKILL.md'),
    '---\nname: impeccable\ndescription: Recorded shell launcher fixture.\n---\nRun scripts/impeccable with bash.\n'
  );
  await writeFile(path.join(scripts, 'impeccable'), '#!/bin/sh\nprintf "SKILL_CONTEXT_OK\\n"\n');
  const rootId = randomUUID();
  const reply = 'Skill and all three Explorers completed.';
  const provider = await startModelProviderShim(({ toolNames, messages }) => {
    if (toolNames.length === 0) {
      return { finalText: 'Luna tool regression' };
    }
    if (!toolNames.includes('agent-explore')) {
      return { finalText: 'Explorer completed.' };
    }
    if (JSON.stringify(messages).includes('Background invocations of this turn')) {
      return { finalText: reply };
    }
    return {
      finalText: reply,
      toolCallStages: [
        [
          {
            arguments: {
              toolNames: [
                'brainstrike_globWorkspace',
                'brainstrike_readWorkspaceFile',
                'brainstrike_runSkillScript',
              ],
            },
            name: 'load_tool',
          },
        ],
        [
          {
            arguments: {
              args: ['context'],
              cwd: '.',
              root: rootId,
              runtime: 'bash',
              scriptPath: 'scripts/impeccable',
              skillName: 'impeccable',
            },
            name: 'brainstrike_runSkillScript',
          },
          ...['one', 'two', 'three'].map((ordinal) => ({
            arguments: { executionMode: 'background', prompt: `Explore fixture ${ordinal}.` },
            name: 'agent-explore',
          })),
        ],
      ],
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
        .fill('Run the skill and delegate three Explorers.');
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
      const approve = region.getByRole('button', {
        exact: true,
        name: 'Approve brainstrike.runSkillScript',
      });
      await expect(approve).toBeVisible();
      await expect
        .poll(async () =>
          (await readHostThreadTree(profile))
            .filter(({ parentThreadId }) => parentThreadId !== undefined)
            .flatMap(({ rows }) =>
              rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []))
            )
        )
        .toEqual(['completed', 'completed', 'completed']);
      await approve.click();
      await expect(region.getByText(reply, { exact: true }).first()).toBeVisible();
      await expect
        .poll(async () =>
          (await readHostThreadTree(profile))
            .filter(({ parentThreadId }) => parentThreadId === undefined)
            .flatMap(({ rows }) =>
              rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []))
            )
        )
        .toContain('completed');
      const tree = await readHostThreadTree(profile);
      expect(JSON.stringify(tree)).toContain('SKILL_CONTEXT_OK');
      expect(JSON.stringify(tree)).not.toContain('"outcome":"failed"');
      const requests = JSON.stringify(provider.requests());
      expect(requests).toContain('alreadyLoaded');
      expect(requests).not.toContain('Tool \\"brainstrike_globWorkspace\\" not found');
      await page.reload();
      await expect(region.getByText(reply, { exact: true }).first()).toBeVisible();
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
