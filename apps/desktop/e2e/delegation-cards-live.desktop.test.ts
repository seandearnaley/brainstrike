import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { launchElectronAppWithOptions } from './utils/electron-helpers.mts';
import { ensureActivityExpanded, ensureAssistantShellVisible } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

const FILES = ['notes.md', 'plan.md'] as const;
const REPLY = 'Both Explorers reported back.';

/**
 * Each open delegation card follows its background child's committed run
 * live (#3719). The children hold their answers until both cards show their
 * tool call, so each card's end can only arrive live, never from its first
 * read of the child's log. Only the model is scripted.
 *
 * The cards are read with their activity group open: a collapsed group's body
 * is a hidden React Activity, which pauses its cards until it is opened, and
 * its `hidden` DOM keeps their last open render (#3442).
 */
test('open delegation cards follow their background children to the end without a reload', async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), 'bs-delegation-cards-live-'));
  const workspace = path.join(profile, 'workspace');
  await mkdir(workspace, { recursive: true });
  await Promise.all(FILES.map((file) => writeFile(path.join(workspace, file), `# ${file}\n`)));
  let answer = (): void => undefined;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const provider = await startModelProviderShim(({ messages, toolNames }) => {
    if (toolNames.length === 0) {
      return { finalText: 'Live delegation cards' };
    }
    const conversation = JSON.stringify(messages);
    if (!toolNames.includes('agent-explore')) {
      const file = FILES.find((name) => conversation.includes(`Read ${name}.`)) ?? FILES[0];
      return {
        beforeFinalText: answered,
        finalText: `Explorer read ${file}.`,
        toolCall: { arguments: { path: file }, name: 'brainstrike_readWorkspaceFile' },
      };
    }
    if (conversation.includes('Background invocations of this turn')) {
      return { finalText: REPLY };
    }
    return {
      finalText: REPLY,
      toolCalls: FILES.map((file) => ({
        arguments: { prompt: `Read ${file}.` },
        name: 'agent-explore',
      })),
    };
  });
  let joined = false;
  try {
    const context = await launchElectronAppWithOptions({
      disableExternalLocalRuntimeProbes: true,
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
        reloadReason: 'delegation-cards-live',
        rootId: randomUUID(),
      });
      await configureAssistantProvider(page, {
        apiKey: 'test-key-delegation-cards-live',
        compositeModelKey: 'openai::gpt-5.4-mini',
        provider: 'openai',
      });
      await enableAssistantCatalogModel(page, 'openai::gpt-5.4-mini');
      await ensureAssistantShellVisible(page);
      const region = page.getByRole('region', { exact: true, name: 'Assistant' });
      await region.getByRole('textbox', { name: 'Message input' }).fill('Explore both files.');
      await region.getByRole('button', { exact: true, name: 'Send' }).click();

      await ensureActivityExpanded(region.getByTestId('assistant-activity-group').first());
      const cards = region.getByTestId('subagent-execution-card');
      await expect(cards).toHaveCount(2);
      await expect(cards.filter({ hasText: / is working\s*· 1 tool call/u })).toHaveCount(2);
      answer();

      // The root's own run, then its wake on both children's results.
      await expect
        .poll(async () =>
          (await readHostThreadTree(profile))
            .filter(({ parentThreadId }) => parentThreadId === undefined)
            .flatMap(({ rows }) =>
              rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []))
            )
        )
        .toEqual(['completed', 'completed']);
      for (const card of await cards.all()) {
        await expect(card).toBeVisible();
        await expect(card).toContainText(/ finished\s*· 1 tool call/u);
      }
      expect(provider.refusals()).toEqual([]);
    } catch (error) {
      answer();
      await testInfo.attach('host-tree', {
        body: JSON.stringify(await readHostThreadTree(profile), null, 2),
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
    // The provider closes however the launch ends; the profile goes once the app has exited.
    await provider.close();
    if (joined) {
      await rm(profile, { force: true, recursive: true });
    }
  }
});
