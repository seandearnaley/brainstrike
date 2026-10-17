/**
 * Provider cassettes through the real desktop app: a recorded scenario replays
 * byte for byte from the model-provider shim into the app's own host, tools,
 * IPC and renderer. The committed log must keep every committed-log invariant,
 * and what the app draws for it must agree with that log: each delegation card
 * counts exactly its child's ledger (#3719).
 *
 * A scenario marked `recordedIn: 'desktop'` is also recorded here, because the
 * app sends what the standalone host never does (thinking disabled, its own
 * tool set). Record mode (`pnpm cassettes:record <id>`, see
 * docs/agents/provider-cassettes.md) runs it against the real provider with
 * the key the person recording exports, and keeps the cassette only if it
 * leaks nothing, shows the behavior the scenario exists for, keeps every
 * invariant and replays here to the conversation it recorded. The host lane
 * then replays it for the renderer-projection checks.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assembleProviderCassette,
  createProviderCassetteRecording,
  encodeProviderCassette,
  type ProviderCassette,
} from '@brainstrike/test-utils/provider-cassette';
import { expect, type Locator, type TestInfo, test } from '@playwright/test';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import {
  type CommittedThread,
  committedConversation,
  delegatedChildThreadIds,
  isSettledConversation,
  type RenderedDelegationCard,
} from './utils/conversation-invariants';
import { launchElectronAppWithOptions } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible, expandEveryActivity } from './utils/layout-helpers';
import type {
  CassetteRouteScript,
  ModelProviderCassetteScript,
} from './utils/model-provider-cassette-route';
import { type ModelProviderShim, startModelProviderShim } from './utils/model-provider-shim';
import {
  recordingFindings,
  recordingUpstreams,
  secretScan,
} from './utils/provider-cassette-recording';
import {
  cassetteFile,
  describeRecording,
  PROVIDER_CASSETTE_SCENARIOS,
  type ProviderCassetteScenario,
  providerOf,
  readScenarioCassette,
} from './utils/provider-cassette-scenarios';
import { seedRoot } from './utils/seed-root';

/** A scenario id: record that desktop scenario instead of replaying it. */
const RECORD = process.env['BRAINSTRIKE_PROVIDER_CASSETTE_RECORD'];
/**
 * Where `pnpm cassettes:record` hands a desktop recording its key. Global setup
 * strips every provider credential the runner inherited (BST-1931), so the key
 * travels under this name alone, and only into a recording run.
 */
const RECORDER_KEY_ENV = 'BRAINSTRIKE_PROVIDER_CASSETTE_RECORDER_KEY';
const WORKSPACE_PLACEHOLDER = '<workspace>';
/** The key a replaying app holds: the shim never reads it. */
const REPLAY_KEY = 'provider-cassette-replay';
/**
 * Where an E2E profile keeps the key the run holds
 * (src/desktop-credential-selection.ts): removed even when the app fails to close.
 */
const CREDENTIAL_FILE = 'brainstrike-credentials.json';

/**
 * The key the record wrapper handed over, taken out of this worker's
 * environment before the app launches: the app inherits the worker's
 * environment, and only the disposable profile's credential store may hold it.
 */
function takeRecorderKey(): string {
  const key = process.env[RECORDER_KEY_ENV];
  delete process.env[RECORDER_KEY_ENV];
  if (!key?.trim()) {
    throw new Error(
      `Recording in the desktop app needs ${RECORDER_KEY_ENV}: record with pnpm cassettes:record <scenario id>.`
    );
  }
  return key;
}

function scenarioNamed(id: string): ProviderCassetteScenario {
  const scenario = PROVIDER_CASSETTE_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(`No provider cassette scenario ${id}`);
  }
  return scenario;
}

function replayOf(
  scenario: ProviderCassetteScenario,
  cassette: ProviderCassette
): (workspace: string) => ModelProviderCassetteScript {
  return (workspace) => ({
    cassette,
    ...(scenario.pace === undefined ? {} : { pace: scenario.pace }),
    substitutions: [{ from: workspace, to: WORKSPACE_PLACEHOLDER }],
  });
}

interface SettledConversation {
  readonly children: readonly CommittedThread[];
  readonly parent: CommittedThread;
}

interface DesktopRun<S> {
  readonly conversation: SettledConversation;
  readonly provider: ModelProviderShim;
  readonly region: Locator;
  readonly script: S;
}

/**
 * Sends the scenario's prompt in a fresh desktop app on a disposable profile,
 * with `script` answering every provider request, and hands the settled
 * conversation to `inspect` while the app is still open.
 */
async function inDesktopApp<S extends CassetteRouteScript, T>(
  scenario: ProviderCassetteScenario,
  setup: { readonly apiKey: string; readonly script: (workspace: string) => S },
  testInfo: TestInfo,
  inspect: (run: DesktopRun<S>) => Promise<T>
): Promise<T> {
  const profile = await mkdtemp(path.join(tmpdir(), 'bs-provider-cassette-'));
  const workspace = path.join(profile, 'cassette-workspace');
  // The app finds skills, personas and commands under HOME; the developer's
  // own would otherwise reach the system prompt, and a recording with them.
  const home = path.join(profile, 'home');
  await mkdir(workspace);
  await mkdir(home);
  for (const [file, content] of Object.entries(scenario.files ?? {})) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), content);
  }
  const script = setup.script(workspace);
  const provider = await startModelProviderShim(script);
  let joined = false;
  const context = await launchElectronAppWithOptions({
    disableExternalLocalRuntimeProbes: true,
    env: { HOME: home },
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
      apiKey: setup.apiKey,
      compositeModelKey: scenario.model,
      provider: providerOf(scenario),
    });
    expect(existsSync(path.join(profile, CREDENTIAL_FILE)), 'the key lives in the profile').toBe(
      true
    );
    await enableAssistantCatalogModel(page, scenario.model);
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill(scenario.prompt);
    await region.getByRole('button', { exact: true, name: 'Send' }).click();

    const read = async (): Promise<SettledConversation> => {
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
    return await inspect({ conversation: await read(), provider, region, script });
  } catch (error) {
    await testInfo.attach('provider-refusals', {
      body: JSON.stringify(provider.refusals(), null, 2),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    try {
      await context.app.close();
      joined = true;
      expect(child.exitCode).toBe(0);
    } finally {
      await provider.close();
      await rm(path.join(profile, CREDENTIAL_FILE), { force: true });
      if (joined) {
        await rm(profile, { force: true, recursive: true });
      }
    }
  }
}

/** What a replay must hold: every request answered, every exchange claimed, no invariant broken. */
function expectFaithfulReplay(provider: ModelProviderShim, violations: readonly unknown[]): void {
  expect(provider.refusals(), 'a cassette must answer every request its replay makes').toEqual([]);
  expect(
    provider.unservedExchanges().map((exchange) => exchange.key),
    'a replay must claim every recorded exchange'
  ).toEqual([]);
  expect(violations).toEqual([]);
}

/**
 * Records the scenario through the desktop app, holding the recorder's key.
 * Nothing is written here: the caller keeps the cassette only once it also
 * replays to the conversation it recorded.
 */
async function recordInDesktopApp(scenario: ProviderCassetteScenario, testInfo: TestInfo) {
  const key = takeRecorderKey();
  const recorded = await inDesktopApp(
    scenario,
    {
      apiKey: key,
      script: (workspace) => ({
        record: createProviderCassetteRecording({
          substitutions: [{ from: workspace, to: WORKSPACE_PLACEHOLDER }],
          upstreams: recordingUpstreams(),
        }),
      }),
    },
    testInfo,
    async ({ conversation, script }) => {
      await expect.poll(() => script.record.inFlight(), { timeout: 60_000 }).toBe(0);
      return {
        cassette: assembleProviderCassette({
          exchanges: script.record.exchanges(),
          recordedAt: new Date().toISOString(),
          scenario: scenario.id,
        }),
        ...committedConversation(conversation),
      };
    }
  );
  expect(
    recordingFindings(recorded.cassette, key),
    'a recording that holds a local path or the key is never saved'
  ).toEqual([]);
  expect(
    await secretScan(recorded.cassette),
    'a recording that trips the secret scanner is never saved'
  ).toBe('');
  if (scenario.exhibits && !scenario.exhibits.holds(recorded.cassette)) {
    throw new Error(
      `${scenario.id}: the recording shows no ${scenario.exhibits.behavior}; not saved. Record it again.\n${describeRecording(recorded.cassette)}`
    );
  }
  expect(recorded.violations, 'a recording that breaks an invariant is never saved').toEqual([]);
  return recorded;
}

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
  const scenario = scenarioNamed('openai-background-delegation');
  await inDesktopApp(
    scenario,
    { apiKey: REPLAY_KEY, script: replayOf(scenario, readScenarioCassette(scenario)) },
    testInfo,
    async ({ conversation, provider, region }) => {
      // A collapsed activity group keeps its cards' last render in hidden DOM
      // (#3740): only cards the user can see are read.
      await expandEveryActivity(region);
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
      expectFaithfulReplay(provider, violations);
    }
  );
});

test('provider cassette anthropic-long-multiblock-answer, recorded in the desktop app, replays there and keeps every committed invariant', async ({}, testInfo) => {
  test.setTimeout(420_000);
  const scenario = scenarioNamed('anthropic-long-multiblock-answer');
  const recorded =
    RECORD === scenario.id ? await recordInDesktopApp(scenario, testInfo) : undefined;
  const cassette = recorded?.cassette ?? readScenarioCassette(scenario);
  const replayed = await inDesktopApp(
    scenario,
    { apiKey: REPLAY_KEY, script: replayOf(scenario, cassette) },
    testInfo,
    async ({ conversation, provider }) => {
      const { shape, violations } = committedConversation(conversation);
      await testInfo.attach('conversation-shape', {
        body: JSON.stringify(shape, null, 2),
        contentType: 'application/json',
      });
      expectFaithfulReplay(provider, violations);
      return shape;
    }
  );
  if (!recorded) {
    return;
  }
  expect(replayed, 'a recording must replay to the conversation it recorded').toEqual(
    recorded.shape
  );
  await mkdir(path.dirname(cassetteFile(scenario)), { recursive: true });
  await writeFile(cassetteFile(scenario), encodeProviderCassette(recorded.cassette));
});
