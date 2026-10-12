// Keep foreground decisions covered explicitly; delegated-worker-write covers background mode.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostRoot, readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { runInteractiveChildFixture } from './utils/interactive-child-fixture';
import {
  ensureActivityExpanded,
  ensureAssistantShellVisible,
  ensureMockWorkspaceOpen,
} from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';
import {
  assembledMarkers,
  createAssembledSubagentFixture,
} from './utils/subagent-integration-fixture';
import { E2E_TIMEOUTS } from './utils/timeouts';

type ChildDecisionScenario =
  | { decision: 'answer'; tool: 'askUser' }
  | { decision: 'approved' | 'rejected'; tool: 'submitPlan' };

// Literal entry points let the CI lane guard discover every scenario.
test('answers a reloaded delegated child question @smoke', async ({ electron }, testInfo) => {
  await assertChildDecision(electron, testInfo, { decision: 'answer', tool: 'askUser' });
});
test('approves a reloaded delegated child plan @smoke', async ({ electron }, testInfo) => {
  await assertChildDecision(electron, testInfo, { decision: 'approved', tool: 'submitPlan' });
});
test('rejects a reloaded delegated child plan @smoke', async ({ electron }, testInfo) => {
  await assertChildDecision(electron, testInfo, { decision: 'rejected', tool: 'submitPlan' });
});

test('assembles concurrent child control, reload, and durable results @smoke', async ({
  electron,
}, testInfo) => {
  await assertAssembledChildControl(electron, testInfo, 'gui');
});

test('real CLI controls GUI children with isolated Stop and committed reload @smoke', async ({
  electron,
}, testInfo) => {
  await assertAssembledChildControl(electron, testInfo, 'cli');
});

const executeCli = promisify(execFile);
const cliRequire = createRequire(import.meta.url);
const cliPath = path.join(
  path.dirname(cliRequire.resolve('@brainstrike/host-capabilities')),
  '../bin/brainstrike.mjs'
);

async function appCli(electron: ElectronHarness, args: readonly string[]): Promise<unknown> {
  const { stdout } = await executeCli(
    process.execPath,
    [cliPath, '--data-root', await readHostRoot(electron.getUserDataDir()), ...args],
    { timeout: E2E_TIMEOUTS.messageVisibility }
  );
  const output: unknown = JSON.parse(stdout);
  return output;
}

async function assertAssembledChildControl(
  electron: ElectronHarness,
  testInfo: TestInfo,
  controls: 'gui' | 'cli'
): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-assembled-subagents-'));
  const fixture = await createAssembledSubagentFixture(workspace);
  const tree = () => readAssembledTree(electron.getUserDataDir());
  // Agent turns advertise tools; the host's thread-title request has none.
  const modelCalls = (): number =>
    fixture.provider.requests().filter(({ toolNames }) => toolNames.length > 0).length;
  const draft = 'UNSENT_ASSEMBLED_ROOT_DRAFT_1770';
  await runInteractiveChildFixture({
    captureFailure: async (window) => {
      await testInfo.attach('assembled-subagent-failure', {
        body: await window.locator('body').innerText(),
        contentType: 'text/plain',
      });
      // The decisions each thread committed, printed so the run log keeps them.
      const decisions = await readHostThreadTree(electron.getUserDataDir())
        .then((logs) =>
          logs.map(({ child, rows, threadId }) => ({
            callSign: child?.callSign ?? 'root',
            events: rows.flatMap(({ event }) =>
              event.type.startsWith('run.') ||
              event.type.startsWith('interaction.') ||
              event.type === 'permission.granted'
                ? [
                    {
                      type: event.type,
                      ...('runId' in event ? { runId: event.runId } : {}),
                      ...('interactionId' in event ? { interactionId: event.interactionId } : {}),
                      ...('toolId' in event ? { toolId: event.toolId } : {}),
                      ...('decision' in event ? { decision: event.decision } : {}),
                      ...('by' in event ? { by: event.by } : {}),
                      ...('grant' in event ? { grant: event.grant } : {}),
                      ...('outcome' in event ? { outcome: event.outcome } : {}),
                    },
                  ]
                : []
            ),
            threadId,
          }))
        )
        .catch((error: unknown) => String(error));
      console.error('ASSEMBLED_HOST_DECISIONS', JSON.stringify(decisions));
      await testInfo.attach('assembled-host-tree', {
        body: JSON.stringify(await tree().catch((error: unknown) => String(error)), null, 2),
        contentType: 'application/json',
      });
      await testInfo.attach('assembled-provider-transcript', {
        body: JSON.stringify(fixture.provider.transcript(), null, 2),
        contentType: 'application/json',
      });
    },
    closeProvider: async () => {
      fixture.releaseAlpha();
      fixture.releaseBeta();
      await fixture.provider.close();
    },
    electron,
    environment: fixture.environment,
    run: async (window) => {
      await ensureMockWorkspaceOpen(window);
      await configureAssistantProvider(window, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
      await new HomePage(window).openSettings();
      const settings = new SettingsPage(window);
      await settings.openCategory(/Permissions/i, 'permissions');
      await window
        .getByRole('combobox', { exact: true, name: 'Read permission' })
        .selectOption('ask');
      // The scenario holds BOTH work permits below ("two work permits"): pin it.
      await settings.setSubagentLimit('Subagent work at once', 'maxConcurrentWork', 2);
      await ensureAssistantShellVisible(window);
      const root = window.getByRole('region', { exact: true, name: 'Assistant' });
      const composer = root.getByRole('textbox', { name: 'Message input' });
      await composer.fill(assembledMarkers.parentPrompt);
      await root.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(root.getByText('ASSEMBLED_ROOT_CONTINUES_1770', { exact: true })).toBeVisible();

      const selectedTab = window
        .getByRole('tablist', { name: 'Workspace tabs' })
        .getByRole('tab', { selected: true });
      // Each delegation is its own activity group, headed by its persona.
      const openChild = async (persona: string, prompt: string) => {
        const activity = root
          .getByTestId('assistant-activity-group')
          .filter({ hasText: `Delegated to ${persona}` });
        await ensureActivityExpanded(activity);
        await activity.getByRole('button', { name: /Open .* conversation/ }).click();
        await expect(selectedTab).toHaveText(/^[A-Z][a-z]+-[a-f0-9]{6}$/u);
        const name = (await selectedTab.innerText()).trim();
        // The card opened the child the host committed for that task.
        expect((await tree()).children.find(({ callSign }) => callSign === name)?.prompt).toBe(
          prompt
        );
        return {
          // The tab ✕ is a mouse-only, aria-hidden sibling of the tab that shows on
          // hover (TabStrip contract), so point at the tab first.
          close: async () => {
            await window.getByRole('tab', { exact: true, name }).hover();
            await window
              .getByRole('button', { exact: true, includeHidden: true, name: `Close ${name}` })
              .click();
          },
          panel: window.getByRole('region', { exact: true, name }),
        };
      };

      const granted = await openChild('parked-grant', 'PARKED_GRANT_TASK_1770');
      const sessionGrant = granted.panel.getByRole('button', {
        exact: true,
        name: 'Allow reads this session brainstrike.readWorkspaceFile',
      });
      await expect(sessionGrant).toBeVisible();
      // Both parked tasks wait on a read approval, which holds no work permit;
      // both streams hold one each.
      await expect
        .poll(async () => byTask(await tree(), ({ status }) => status))
        .toEqual({
          ['PARKED_GRANT_TASK_1770']: 'needs-input',
          ['PARKED_STOP_TASK_1770']: 'needs-input',
          ['STREAM_ALPHA_TASK_1770']: 'working',
          ['STREAM_BETA_TASK_1770']: 'working',
        });
      expect(byTask(await tree(), ({ runIds }) => runIds.length)).toEqual(ONE_RUN_EACH);
      const cliHost = controls === 'cli' ? await appCli(electron, ['host', 'status']) : null;
      if (controls === 'cli') {
        const logs = await readHostThreadTree(electron.getUserDataDir());
        for (const log of logs.filter(({ parentThreadId }) => parentThreadId !== undefined)) {
          const pending = log.rows.find(
            ({ event }) => event.type === 'interaction.requested'
          )?.event;
          if (pending?.type !== 'interaction.requested') {
            continue;
          }
          await appCli(electron, [
            'interaction',
            'respond',
            '--thread',
            log.threadId,
            '--run',
            pending.runId,
            '--interaction',
            pending.interactionId,
            '--decision',
            'approve',
          ]);
        }
      } else {
        await sessionGrant.click();
      }
      // The session grant answers both parked reads, but their tools cannot run
      // until a permit frees: both held model responses own the two.
      await expect
        .poll(async () => byTask(await tree(), ({ status }) => status))
        .toEqual({
          ['PARKED_GRANT_TASK_1770']: 'working',
          ['PARKED_STOP_TASK_1770']: 'working',
          ['STREAM_ALPHA_TASK_1770']: 'working',
          ['STREAM_BETA_TASK_1770']: 'working',
        });
      expect(reads(await tree())).toBe(0);
      await granted.close();

      await composer.fill(draft);
      const stopped = await openChild('stream-alpha', 'STREAM_ALPHA_TASK_1770');
      const stop = stopped.panel.getByRole('button', { exact: true, name: 'Stop' });
      await expect(stop).toBeVisible();
      if (controls === 'cli') {
        const alpha = (await tree()).children.find(
          ({ prompt }) => prompt === 'STREAM_ALPHA_TASK_1770'
        );
        expect(alpha).toBeDefined();
        if (!alpha?.runIds[0]) {
          throw new Error('The host did not commit Alpha’s run identity');
        }
        await appCli(electron, [
          'child',
          'stop',
          '--thread',
          alpha.threadId,
          '--run',
          alpha.runIds[0],
        ]);
      } else {
        await stop.click();
      }
      // Alpha's freed permit lets both parked tasks read and finish; Beta still streams.
      await expect
        .poll(async () => byTask(await tree(), ({ outcomes }) => outcomes))
        .toEqual({
          ['PARKED_GRANT_TASK_1770']: ['completed'],
          ['PARKED_STOP_TASK_1770']: ['completed'],
          ['STREAM_ALPHA_TASK_1770']: ['stopped'],
          ['STREAM_BETA_TASK_1770']: [],
        });
      expect(byTask(await tree(), ({ status }) => status)['STREAM_BETA_TASK_1770']).toBe('working');
      await stopped.close();
      await expect(composer).toHaveValue(draft);
      // The root reads the three settled tasks before the reload, so no wake is in flight.
      await expect
        .poll(async () => {
          const { deliveries, rootRuns } = await tree();
          return {
            rootRunning: rootRuns.includes('running'),
            states: deliveries.map(({ state }) => state).sort(),
          };
        })
        .toEqual({ rootRunning: false, states: ['cancelled', 'returned', 'returned'] });

      const beforeReload = modelCalls();
      await window.reload();
      await configureAssistantProvider(window, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
      await ensureAssistantShellVisible(window);
      await expect.soft(composer).toHaveValue(draft);
      expect(modelCalls()).toBe(beforeReload);
      // The host kept Beta's run through the window's reload.
      const afterReload = await tree();
      expect(byTask(afterReload, ({ status }) => status)['STREAM_BETA_TASK_1770']).toBe('working');
      expect(byTask(afterReload, ({ outcomes }) => outcomes)['STREAM_BETA_TASK_1770']).toEqual([]);
      fixture.releaseBeta();
      if (controls === 'cli') {
        const beta = afterReload.children.find(({ prompt }) => prompt === 'STREAM_BETA_TASK_1770');
        expect(beta).toBeDefined();
        await expect
          .poll(async () => {
            const logs = await readHostThreadTree(electron.getUserDataDir());
            return logs
              .find(({ threadId }) => threadId === beta?.threadId)
              ?.rows.some(({ event }) => event.type === 'interaction.requested');
          })
          .toBe(true);
        const logs = await readHostThreadTree(electron.getUserDataDir());
        const pending = logs
          .find(({ threadId }) => threadId === beta?.threadId)
          ?.rows.find(({ event }) => event.type === 'interaction.requested')?.event;
        if (!beta || pending?.type !== 'interaction.requested') {
          throw new Error('The host did not commit Beta’s approval identity');
        }
        await appCli(electron, [
          'interaction',
          'respond',
          '--thread',
          beta.threadId,
          '--run',
          pending.runId,
          '--interaction',
          pending.interactionId,
          '--decision',
          'approve',
        ]);
      }
      await expect(root.getByText(assembledMarkers.parentResult, { exact: true })).toBeVisible();
      const survivor = await openChild('stream-beta', 'STREAM_BETA_TASK_1770');
      await expect(
        survivor.panel.getByText(assembledMarkers.streamB, { exact: true })
      ).toBeVisible();
      await survivor.close();

      await expect
        .poll(async () => {
          const { deliveries, rootRuns } = await tree();
          return { deliveries: deliveries.length, rootRunning: rootRuns.includes('running') };
        })
        .toEqual({ deliveries: 4, rootRunning: false });
      const persisted = await tree();
      expect(persisted.rootRuns.length).toBeGreaterThanOrEqual(2);
      expect(persisted.rootRuns.every((outcome) => outcome === 'completed')).toBe(true);
      // One invocation per task, each ending once; Alpha alone was stopped.
      expect(byTask(persisted, ({ runIds }) => runIds.length)).toEqual(ONE_RUN_EACH);
      expect(byTask(persisted, ({ outcomes }) => outcomes)).toEqual({
        ['PARKED_GRANT_TASK_1770']: ['completed'],
        ['PARKED_STOP_TASK_1770']: ['completed'],
        ['STREAM_ALPHA_TASK_1770']: ['stopped'],
        ['STREAM_BETA_TASK_1770']: ['completed'],
      });
      expect(byTask(persisted, ({ status }) => status)).toEqual({
        ['PARKED_GRANT_TASK_1770']: 'idle',
        ['PARKED_STOP_TASK_1770']: 'idle',
        ['STREAM_ALPHA_TASK_1770']: 'idle',
        ['STREAM_BETA_TASK_1770']: 'idle',
      });
      // Finished model steps carry usage; Alpha was stopped before its first finished.
      expect(byTask(persisted, ({ modelSteps }) => modelSteps > 0)).toEqual({
        ['PARKED_GRANT_TASK_1770']: true,
        ['PARKED_STOP_TASK_1770']: true,
        ['STREAM_ALPHA_TASK_1770']: false,
        ['STREAM_BETA_TASK_1770']: true,
      });
      expect(new Set(persisted.children.map(({ toolCallId }) => toolCallId)).size).toBe(4);
      const resultMarkerByTask = new Map([
        ['PARKED_GRANT_TASK_1770', assembledMarkers.parkedApproved],
        ['PARKED_STOP_TASK_1770', 'PARKED_STOP_SURVIVOR_COMPLETE_1770'],
        ['STREAM_BETA_TASK_1770', assembledMarkers.streamB],
      ]);
      for (const child of persisted.children) {
        // The delegation call's own result is the dispatch acknowledgement, once.
        expect(
          persisted.dispatches.filter(({ toolCallId }) => toolCallId === child.toolCallId)
        ).toEqual([
          { childThreadId: child.threadId, status: 'started', toolCallId: child.toolCallId },
        ]);
        // The parent reads each task's outcome exactly once, from that task's run.
        const delivered = persisted.deliveries.filter(
          ({ toolCallId }) => toolCallId === child.toolCallId
        );
        expect(delivered).toEqual([
          expect.objectContaining({
            childRunId: child.runIds[0],
            childThreadId: child.threadId,
            state: child.prompt === 'STREAM_ALPHA_TASK_1770' ? 'cancelled' : 'returned',
          }),
        ]);
        const marker = resultMarkerByTask.get(child.prompt);
        if (marker) {
          expect(delivered[0]?.outcome).toContain(marker);
        }
      }
      // Alpha is stopped before the shim emits tool_calls finish; only the
      // three survivors may execute the workspace read.
      expect(byTask(persisted, ({ reads: count }) => count)).toEqual({
        ['PARKED_GRANT_TASK_1770']: 1,
        ['PARKED_STOP_TASK_1770']: 1,
        ['STREAM_ALPHA_TASK_1770']: 0,
        ['STREAM_BETA_TASK_1770']: 1,
      });

      // Title requests quote the root user prompt too, but have no tool catalog.
      const parentRequests = fixture
        .requests()
        .filter((request) => request.toolNames.includes('agent-stream-alpha'));
      const finalParentInput = JSON.stringify(parentRequests.at(-1)?.messages);
      expect(finalParentInput).toContain(assembledMarkers.streamB);
      expect(finalParentInput).toContain(assembledMarkers.parkedApproved);
      expect(finalParentInput).toContain('PARKED_STOP_SURVIVOR_COMPLETE_1770');
      expect(finalParentInput).not.toContain('ASSEMBLED_EVIDENCE_1770');

      const completedCalls = modelCalls();
      await window.reload();
      await ensureAssistantShellVisible(window);
      await expect(root.getByText(assembledMarkers.parentResult, { exact: true })).toBeVisible();
      expect(await tree()).toEqual(persisted);
      expect(modelCalls()).toBe(completedCalls);
      if (controls === 'cli') {
        expect(await appCli(electron, ['host', 'status'])).toEqual(cliHost);
        for (const { threadId, rows } of await readHostThreadTree(electron.getUserDataDir())) {
          expectReadAfter(await appCli(electron, ['thread', 'read', '--thread', threadId]), rows);
          const fromSeq = rows[Math.floor(rows.length / 2)]?.seq ?? 0;
          expectReadAfter(
            await appCli(electron, [
              'thread',
              'read',
              '--thread',
              threadId,
              '--from-seq',
              String(fromSeq),
            ]),
            rows.filter(({ seq }) => seq > fromSeq)
          );
        }
      }
    },
    workspace,
  });
}

const ONE_RUN_EACH = {
  ['PARKED_GRANT_TASK_1770']: 1,
  ['PARKED_STOP_TASK_1770']: 1,
  ['STREAM_ALPHA_TASK_1770']: 1,
  ['STREAM_BETA_TASK_1770']: 1,
};

type AssembledTree = Awaited<ReturnType<typeof readAssembledTree>>;
type AssembledChild = AssembledTree['children'][number];

/** One fact per delegated task, keyed by the task's prompt. */
function byTask<T>(
  { children }: AssembledTree,
  pick: (child: AssembledChild) => T
): Record<string, T> {
  return Object.fromEntries(children.map((child) => [child.prompt, pick(child)]));
}

function reads({ children }: AssembledTree): number {
  return children.reduce((total, child) => total + child.reads, 0);
}

/**
 * A CLI read of an append-only thread log, made after `rows` were read. The
 * GUI commits its workspace snapshot after a reload whenever its renderer gets
 * there, so the read holds `rows`, then nothing but that commit.
 */
function expectReadAfter(read: unknown, rows: readonly unknown[]): void {
  const later: unknown = record(read)['rows'];
  if (!Array.isArray(later)) {
    throw new Error('The CLI read returned no rows');
  }
  const laterRows: readonly unknown[] = later;
  expect({ rows: laterRows.slice(0, rows.length) }).toMatchObject({ rows });
  expect(laterRows.slice(rows.length).filter((row) => !isWorkspaceCommit(row))).toEqual([]);
}

function isWorkspaceCommit(row: unknown): boolean {
  const event = record(record(row)['event']);
  return (
    event['type'] === 'workspace.updated' ||
    (event['type'] === 'command.accepted' && event['method'] === 'thread/workspace/set')
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * The fan-out as the agent host committed it: how each root run ended, each
 * delegated task's runs and pauses, the root's dispatch acknowledgements, and
 * every settled task the root's runs delivered to its model.
 */
async function readAssembledTree(userDataDir: string) {
  const logs = await readHostThreadTree(userDataDir);
  const rootLog = logs.find(({ parentThreadId }) => parentThreadId === undefined);
  if (!rootLog) {
    throw new Error('The host committed no root thread');
  }
  const rootEvents = rootLog.rows.map(({ event }) => event);
  const children = logs
    .filter(({ parentThreadId }) => parentThreadId === rootLog.threadId)
    .map(({ child, rows, threadId }) => {
      const events = rows.map(({ event }) => event);
      const origin = events.flatMap((event) =>
        event.type === 'thread.started' && 'origin' in event ? [event.origin] : []
      )[0];
      const runs = events.flatMap((event) => (event.type === 'run.started' ? [event] : []));
      const prompt = runs[0]?.prompt;
      if (!(child && origin && prompt)) {
        throw new Error(`Child ${threadId} is listed without its committed origin and run`);
      }
      return {
        callSign: child.callSign,
        modelSteps: events.filter(({ type }) => type === 'model.step').length,
        outcomes: events.flatMap((event) => (event.type === 'run.finished' ? [event.outcome] : [])),
        prompt,
        // These personas hold one tool, readWorkspaceFile: each committed result is a read.
        reads: events.filter(({ type }) => type === 'effect.finished').length,
        runIds: runs.map(({ runId }) => runId),
        status: child.status,
        threadId,
        toolCallId: origin.toolCallId,
      };
    });
  const delegations = new Set(children.map(({ toolCallId }) => toolCallId));
  return {
    children,
    deliveries: rootEvents.flatMap((event) =>
      event.type === 'run.started' && event.delivery ? event.delivery.entries : []
    ),
    dispatches: rootEvents.flatMap((event) =>
      event.type === 'effect.finished' && delegations.has(event.toolCallId)
        ? [
            {
              childThreadId: record(event.output)['childThreadId'],
              status: record(event.output)['status'],
              toolCallId: event.toolCallId,
            },
          ]
        : []
    ),
    rootRuns: rootEvents.flatMap((event) =>
      event.type === 'run.started'
        ? [
            rootEvents.flatMap((later) =>
              later.type === 'run.finished' && later.runId === event.runId ? [later.outcome] : []
            )[0] ?? 'running',
          ]
        : []
    ),
  };
}

// Only model transport is scripted. Workspace persona discovery, the assistant
// host, native suspension, persistence and shared workspace controls stay real.
async function assertChildDecision(
  electron: ElectronHarness,
  testInfo: TestInfo,
  scenario: ChildDecisionScenario
): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-child-interactive-'));
  const personaDirectory = path.join(workspace, '.brainstrike', 'agents');
  await mkdir(personaDirectory, { recursive: true });
  await writeFile(
    path.join(personaDirectory, 'decision-probe.md'),
    `---\nname: Decision Probe\ndescription: Requests an exact user decision.\ntools:\n  - ${scenario.tool}\n---\nAsk the user for the requested decision and report the result.`
  );
  const answer = 'CHILD_EXACT_ANSWER_1720';
  const feedback = 'CHILD_EXACT_REJECTION_1720';
  const childResult = `CHILD_${scenario.decision.toUpperCase()}_COMPLETE_1720`;
  const parentResult = `PARENT_${scenario.decision.toUpperCase()}_COMPLETE_1720`;
  const observed = { childDecision: false, parentResult: false };
  const parentCatalogs: string[][] = [];
  const provider = await startModelProviderShim(({ toolNames, messages }) => {
    // The thread-title request advertises no tools, but quotes the root's prompt.
    if (toolNames.length === 0) {
      return { finalText: 'Decision probe task' };
    }
    const history = JSON.stringify(messages);
    const isParent = JSON.stringify(
      messages
        .filter(
          (message) =>
            message && typeof message === 'object' && 'role' in message && message.role === 'user'
        )
        .at(-1)
    ).includes('Delegate to Decision Probe to request my decision.');
    if (isParent) {
      parentCatalogs.push([...toolNames].sort());
      observed.parentResult ||= history.includes(childResult);
      return {
        finalText: parentResult,
        toolCall: {
          arguments: {
            _background: { enabled: false },
            prompt: 'Request my decision, then report the exact outcome.',
          },
          name: 'agent-decision-probe',
        },
      };
    }
    // Match tool result content, not the scripted final response: the model
    // must receive the actual resumed decision through the native tool path.
    observed.childDecision ||=
      scenario.decision === 'answer'
        ? history.includes(answer)
        : history.includes(`\\"status\\":\\"${scenario.decision}\\"`) ||
          history.includes(`"status":"${scenario.decision}"`);
    if (scenario.decision === 'rejected') {
      observed.childDecision &&= history.includes(feedback);
    }
    return {
      finalText: childResult,
      toolCall: {
        arguments:
          scenario.tool === 'askUser'
            ? { question: 'Which exact marker should this child report?' }
            : {
                overview: 'Request a decision without modifying the workspace.',
                steps: [{ title: 'Report the exact user decision to the parent.' }],
                title: 'Child decision plan',
              },
        name: `brainstrike_${scenario.tool}`,
      },
    };
  });
  const environment = {
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: 'isolated-child-interactive-key',
    OPENROUTER_BASE_URL: provider.baseUrl,
  };
  await runInteractiveChildFixture({
    captureFailure: async (window) => {
      await testInfo.attach('interactive-child-failure', {
        body: await window.locator('body').innerText(),
        contentType: 'text/plain',
      });
    },
    closeProvider: () => provider.close(),
    electron,
    environment,
    run: async (window) => {
      await ensureMockWorkspaceOpen(window);
      await configureAssistantProvider(window, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
      await new HomePage(window).openSettings();
      await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
      await window
        .getByRole('combobox', { exact: true, name: 'Read permission' })
        .selectOption('allow');
      await ensureAssistantShellVisible(window);
      const root = window.getByRole('region', { exact: true, name: 'Assistant' });
      await root
        .getByRole('textbox', { name: 'Message input' })
        .fill('Delegate to Decision Probe to request my decision.');
      await root.getByRole('button', { exact: true, name: 'Send' }).click();
      // The root is told its child waits (AT-08); the child itself holds the decision.
      const waiting = root.getByTestId('host-child-waiting');
      await expect(waiting).toBeVisible();
      await expect(waiting).toHaveAttribute(
        'data-kind',
        scenario.tool === 'askUser' ? 'question' : 'plan'
      );
      const noticeName = scenario.tool === 'askUser' ? 'Question for you' : 'Plan decision';
      await root.getByRole('button', { exact: true, name: 'Expand activity' }).click();
      await root.getByRole('button', { name: /Open .* conversation/ }).click();
      const childTab = window
        .getByRole('tablist', { name: 'Workspace tabs' })
        .getByRole('tab', { selected: true });
      await expect(childTab).toHaveText(/^[A-Z][a-z]+-[a-f0-9]{6}$/);
      const childName = (await childTab.innerText()).trim();
      const child = window.getByRole('region', { exact: true, name: childName });
      await expect(child.getByRole('group', { name: noticeName })).toBeVisible();
      // A reload must not run the agent. Count the requests that advertise tools:
      // the host's thread-title call (no tools) may land after the pause.
      const modelCalls = (): number =>
        provider.requests().filter(({ toolNames }) => toolNames.length > 0).length;
      const pausedRequests = modelCalls();
      await window.reload();
      await configureAssistantProvider(window, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
      await ensureAssistantShellVisible(window);
      const notice = child.getByRole('group', { name: noticeName });
      await expect(notice).toBeVisible();
      expect(modelCalls()).toBe(pausedRequests);
      if (scenario.decision === 'answer') {
        await notice.getByRole('textbox', { name: 'Your answer' }).fill(answer);
        await notice.getByRole('button', { exact: true, name: 'Send answer' }).click();
      } else {
        if (scenario.decision === 'rejected') {
          await notice.getByRole('textbox', { name: 'Plan feedback' }).fill(feedback);
        }
        await notice
          .getByRole('button', {
            exact: true,
            name: scenario.decision === 'approved' ? 'Approve plan' : 'Reject plan',
          })
          .click();
      }
      await expect(child.getByText(childResult, { exact: true })).toBeVisible();
      await expect(root.getByText(parentResult, { exact: true })).toBeVisible();
      expect(observed).toEqual({ childDecision: true, parentResult: true });
      await expect(root.getByTestId('host-child-waiting')).toHaveCount(0);
      expect(modelCalls()).toBe(pausedRequests + 2);
      expect(parentCatalogs).toHaveLength(2);
      expect(parentCatalogs[1]).toEqual(parentCatalogs[0]);
      const completedRequests = modelCalls();
      // The tab ✕ is a mouse-only, aria-hidden sibling of the tab that shows on
      // hover (TabStrip contract), so point at the tab first.
      await window.getByRole('tab', { exact: true, name: childName }).hover();
      await window
        .getByRole('button', { exact: true, includeHidden: true, name: `Close ${childName}` })
        .click();
      await expect(root.getByText(parentResult, { exact: true })).toBeVisible();
      expect(modelCalls()).toBe(completedRequests);
      await window.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath('child-decision.png'),
      });
    },
    workspace,
  });
}
