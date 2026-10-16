import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

/**
 * BST-1777: the per-tool execution guard (packages/agent/src/tools/guard-tool-execution.ts,
 * wired in packages/agent/src/mastra/runtime-assembly/tool-pipeline.ts) used to
 * apply the flat global default (`BRAINSTRIKE_TOOL_TIMEOUT_MS`) to EVERY tool,
 * including `brainstrike.executeCommand`, whose contract declares its own
 * budget (`timeoutMs` default 120000ms / max 600000ms). Post-fix, a tool with
 * a declared budget ignores the global default (resolve-tool-guard-budget.ts),
 * and the stream stall watchdog (`BRAINSTRIKE_STREAM_INACTIVITY_MS`) no longer
 * measures a running tool against provider silence.
 *
 * This drives the REAL agent runtime end to end (real Mastra tool-execution
 * loop, real permission engine, real `executeCommand`) via
 * model-provider-shim.ts against OPENROUTER_BASE_URL — not assistant-mock.ts,
 * which replaces the app's own /assistant endpoint and would exercise none of
 * this fix. Both env windows are shrunk (3s guard default, 5s stall window)
 * so an 8s command proves the fix fast instead of waiting out the real 60s/120s
 * production defaults.
 */

const MODEL_PROVIDER_SHIM_API_KEY = 'test-key-e2e-tool-budget';
const BUDGET_ENV = {
  BRAINSTRIKE_STREAM_INACTIVITY_MS: '5000',
  BRAINSTRIKE_TOOL_TIMEOUT_MS: '3000',
} as const;

async function allowExecuteWithoutApproval(
  window: Awaited<ReturnType<ElectronHarness['ensureWindow']>>
): Promise<void> {
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
  await window
    .getByRole('combobox', { exact: true, name: 'Execute permission' })
    .selectOption('allow');
}

test.describe('Assistant tool execution budget (desktop, BST-1777)', () => {
  test('a command past the old guard ceiling completes', async ({ electron }, testInfo) => {
    await runBudgetCase(electron, testInfo, {
      // `command` itself contains the literal substring "budget-ok" (as the
      // argument echoed inline in the card header via extractPrimaryArg), so
      // asserting on the header text alone would pass even if the tool never
      // actually ran. Expanding the row's own Result pane
      // (tool-fallback-body.tsx's ToolDetailsPane) proves the ACTUAL captured
      // stdout, not the echoed argument.
      assertOutcome: async ({ toolCard }) => {
        await toolCard.getByRole('button').first().click();
        await expect(toolCard.getByText('Result:', { exact: true })).toBeVisible();
        // The Result pane is the LAST <pre> in the details pane (Arguments,
        // then Result — tool-fallback-body.tsx's ToolDetailsPane), formatted
        // via formatResult()'s JSON.stringify(result, null, 2): the tool's
        // real captured `stdout` field, not the args echo above it.
        await expect(toolCard.locator('pre').last()).toContainText('budget-ok');
      },
      command: 'sleep 8 && echo budget-ok',
    });
  });

  test("the tool's own deadline wins the race", async ({ electron }, testInfo) => {
    await runBudgetCase(electron, testInfo, {
      assertOutcome: async ({ toolCard }) => {
        // The command's OWN timeout (2000ms) resolves well before the guard's
        // deadline (min(2000, 600000) + 5000 = 7000ms per
        // resolve-tool-guard-budget.ts), so the visible result is the tool's
        // own `timedOut: true` result field (execute-command-tool.ts /
        // execute-command-model-projection.ts), never the guard's generic
        // "did not finish within its" timeout error text (already asserted
        // absent above).
        await toolCard.getByRole('button').first().click();
        await expect(toolCard.getByText('Result:', { exact: true })).toBeVisible();
        await expect(toolCard.locator('pre').last()).toContainText('"timedOut": true');
      },
      command: 'sleep 8',
      timeoutMs: 2000,
    });
  });
});

async function runBudgetCase(
  electron: ElectronHarness,
  testInfo: import('@playwright/test').TestInfo,
  {
    command,
    timeoutMs,
    assertOutcome,
  }: {
    readonly assertOutcome: (context: {
      readonly root: import('@playwright/test').Locator;
      readonly toolCard: import('@playwright/test').Locator;
    }) => Promise<void>;
    readonly command: string;
    readonly timeoutMs?: number;
  }
): Promise<void> {
  const failures: unknown[] = [];
  let ownedProcess: ChildProcess | undefined;
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-tool-budget-'));
  let rootTurns = 0;
  const provider = await startModelProviderShim(({ toolNames }) => {
    // The thread's title request, made beside the first turn, advertises no tools.
    if (toolNames.length === 0) {
      return { finalText: 'Tool budget' };
    }
    rootTurns += 1;
    if (rootTurns === 1) {
      return {
        finalText: 'finished',
        toolCall: {
          arguments: timeoutMs === undefined ? { command } : { command, timeoutMs },
          name: 'brainstrike_executeCommand',
        },
      };
    }
    return { finalText: 'finished' };
  });
  const environment = {
    ...BUDGET_ENV,
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: MODEL_PROVIDER_SHIM_API_KEY,
    OPENROUTER_BASE_URL: provider.baseUrl,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  try {
    const window = await electron.ensureWindow();
    ownedProcess = (await electron.ensureContext()).app.process();
    try {
      await ensureMockWorkspaceOpen(window);
      await configureAssistantProvider(window, {
        apiKey: MODEL_PROVIDER_SHIM_API_KEY,
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
      // Set the execute risk category to `allow` so `brainstrike.executeCommand`
      // (default policy `ask`, docs/agents/assistant-runtime.md) runs without a
      // human approval step in the way of this proof — the guard/watchdog
      // budgets are what is under test, not the approval UI.
      await allowExecuteWithoutApproval(window);
      await ensureAssistantShellVisible(window);
      const root = window.getByRole('region', { exact: true, name: 'Assistant' });
      await root
        .getByRole('textbox', { name: 'Message input' })
        .fill('Run the scripted command that proves the tool budget.');
      await root.getByRole('button', { exact: true, name: 'Send' }).click();

      const activityGroup = root.getByTestId('assistant-activity-group').first();
      // sleep 8 plus real app overhead. The shrunk 5s inactivity window does
      // NOT apply here — that is the whole point: the call sits in the
      // `tool-executing` phase, measured against the tool's own ~7-8s guard
      // budget instead. Pre-fix it both stalled (5s inactivity) and
      // guard-timed-out (3s).
      await expect(activityGroup).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
      await root.getByTestId('assistant-activity-summary').first().click();
      const toolCard = root.getByTestId('tool-fallback').first();
      await expect(toolCard).toBeVisible({ timeout: 15_000 });

      await expect(root.getByText('finished', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(root.getByText('Run failed')).toHaveCount(0);
      await expect(root.getByText(/did not finish within its/)).toHaveCount(0);
      await expect(root.getByText(/stalled/)).toHaveCount(0);
      await assertOutcome({ root, toolCard });

      await window.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath('tool-budget-result.png'),
      });
    } catch (error) {
      failures.push(error);
      try {
        await window.screenshot({ path: testInfo.outputPath('tool-budget-failure.png') });
      } catch (screenshotError) {
        failures.push(screenshotError);
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    for (const cleanup of [
      async () => {
        // Resolves once the process has exited.
        await electron.dispose();
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
    throw new AggregateError(failures, 'Tool budget acceptance and fixture cleanup failed', {
      cause: failures[0],
    });
  }
}
