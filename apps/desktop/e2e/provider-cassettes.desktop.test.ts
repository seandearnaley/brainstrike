/**
 * Provider cassettes through the real desktop app: a scenario recorded on the
 * standalone host replays byte for byte from the model-provider shim into the
 * app's own host, tools, IPC and renderer. The committed log must keep every
 * committed-log invariant, and what the app draws for it must agree with that
 * log: each delegation card counts exactly its child's ledger (#3719).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import {
  committedConversation,
  delegatedChildThreadIds,
  isSettledConversation,
  type RenderedDelegationCard,
} from './utils/conversation-invariants';
import { launchElectronAppWithOptions } from './utils/electron-helpers.mts';
import { ensureActivityExpanded, ensureAssistantShellVisible } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';
import {
  PROVIDER_CASSETTE_SCENARIOS,
  providerOf,
  readScenarioCassette,
} from './utils/provider-cassette-scenarios';
import { seedRoot } from './utils/seed-root';

/** The scenario whose rendered cards the desktop checks. */
const SCENARIO_ID = 'openai-background-delegation';

/** A card's drawn state and count: "Explorer finished · 2 tool calls". */
function readCard(text: string, childThreadId: string): RenderedDelegationCard {
  const count = /· (\d+) tool calls?/u.exec(text)?.[1];
  return {
    childThreadId,
    state: text.split('·')[0]?.split('agent-')[0]?.trim() ?? text,
    toolCalls: count === undefined ? null : Number(count),
  };
}

test('provider cassette openai-background-delegation replays through the desktop app and its cards match the committed log', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const scenario = PROVIDER_CASSETTE_SCENARIOS.find((candidate) => candidate.id === SCENARIO_ID);
  if (!scenario) {
    throw new Error(`No provider cassette scenario ${SCENARIO_ID}`);
  }
  const cassette = readScenarioCassette(scenario);
  const profile = await mkdtemp(path.join(tmpdir(), 'bs-provider-cassette-'));
  const workspace = path.join(profile, 'cassette-workspace');
  await mkdir(workspace);
  for (const [file, content] of Object.entries(scenario.files ?? {})) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), content);
  }
  const provider = await startModelProviderShim({
    cassette,
    ...(scenario.pace === undefined ? {} : { pace: scenario.pace }),
    substitutions: [{ from: workspace, to: '<workspace>' }],
  });
  let joined = false;
  const context = await launchElectronAppWithOptions({
    disableExternalLocalRuntimeProbes: true,
    modelProvider: provider,
    userDataDir: profile,
    workspaceRoot: workspace,
  });
  const child = context.app.process();
  try {
    const page = context.window;
    await expect(page.getByTestId('new-agent-button')).toBeVisible({ timeout: 60_000 });
    await seedRoot(page, workspace, {
      disableBackgroundIndexing: true,
      reloadReason: 'provider-cassette',
      rootId: randomUUID(),
    });
    await configureAssistantProvider(page, {
      apiKey: 'provider-cassette-replay',
      compositeModelKey: scenario.model,
      provider: providerOf(scenario),
    });
    await enableAssistantCatalogModel(page, scenario.model);
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill(scenario.prompt);
    await region.getByRole('button', { exact: true, name: 'Send' }).click();

    const read = async () => {
      const tree = await readHostThreadTree(profile);
      const root = tree.find((thread) => thread.parentThreadId === undefined);
      if (!root) {
        throw new Error('The app committed no root thread');
      }
      return {
        children: tree
          .filter((thread) => thread.parentThreadId === root.threadId)
          .map(({ rows, threadId }) => ({ rows, threadId })),
        parent: { rows: root.rows, threadId: root.threadId },
      };
    };
    await expect
      .poll(
        async () => {
          const { children, parent } = await read();
          return isSettledConversation(
            scenario.children ?? 0,
            parent.rows,
            children.map(({ rows }) => rows)
          );
        },
        { timeout: 180_000 }
      )
      .toBe(true);
    const conversation = await read();
    // A collapsed activity group keeps its cards' last render in hidden DOM
    // (#3740): only cards the user can see are read.
    await ensureActivityExpanded(region);
    const cards = region.getByTestId('subagent-execution-card');
    const childThreadIds = delegatedChildThreadIds(conversation.parent.rows);
    await expect(cards).toHaveCount(childThreadIds.length);
    for (const card of await cards.all()) {
      await expect(card).toBeVisible();
    }
    // Settled: once every child finished, no visible card still reads as working.
    await expect(cards.filter({ hasText: /\bworking\b/u })).toHaveCount(0);
    const rendered = (await cards.allInnerTexts()).map((text, index) =>
      readCard(text, childThreadIds[index] ?? 'unmapped')
    );
    const { shape, violations } = committedConversation({ ...conversation, cards: rendered });
    await testInfo.attach('conversation-shape', {
      body: JSON.stringify({ cards: rendered, shape }, null, 2),
      contentType: 'application/json',
    });
    expect(provider.refusals()).toEqual([]);
    expect(provider.unservedExchanges().map((exchange) => exchange.key)).toEqual([]);
    expect(violations).toEqual([]);
  } catch (error) {
    await testInfo.attach('provider-refusals', {
      body: JSON.stringify(provider.refusals(), null, 2),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    await context.app.close();
    joined = true;
    expect(child.exitCode).toBe(0);
    await provider.close();
    if (joined) {
      await rm(profile, { force: true, recursive: true });
    }
  }
});
