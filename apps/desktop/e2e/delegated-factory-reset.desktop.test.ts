import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { readDelegatedResetState, seedDelegatedResetState } from './utils/delegated-reset-seed';
import {
  ensureAssistantShellVisible,
  ensureMockWorkspaceOpen,
  waitForDatabaseReady,
} from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

async function openSubagents(page: Page): Promise<void> {
  await new HomePage(page).openSettings();
  await new SettingsPage(page).openCategory(/Subagents/i, 'subagents');
}

async function sendInventoryProbe(page: Page, marker: string): Promise<void> {
  await ensureAssistantShellVisible(page);
  const panel = page
    .getByRole('region', { exact: true, name: 'Assistant' })
    .filter({ visible: true });
  await panel.getByRole('textbox', { name: 'Message input' }).fill(marker);
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByText(`${marker} complete`, { exact: true })).toBeVisible();
}

const ENABLED_PROBE = 'RESET_RELEASE_ENABLED';
const DISABLED_PROBE = 'RESET_RELEASE_DISABLED';
const RESTORED_PROBE = 'RESET_RELEASE_RESTORED';

test.fixme(
  'Settings disables actual delegation tools and factory reset removes delegated state @destructive @desktop-ipc-reset',
  { annotation: { description: 'BST-1959', type: 'quarantine' } },
  async ({ electron }, testInfo) => {
    async function confirmReset(page: Page, confirmed: boolean): Promise<void> {
      // Exercise the product's existing native-confirm branch exactly once.
      await page.evaluate((confirmed) => {
        const original = window.confirm;
        window.confirm = () => {
          window.confirm = original;
          return confirmed;
        };
      }, confirmed);
      await page.getByTestId('factory-reset-button').click();
    }

    const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-delegated-reset-'));
    const sentinel = path.join(workspace, 'keep-user-workspace.txt');
    await writeFile(sentinel, 'USER_WORKSPACE_MUST_SURVIVE_RESET\n');
    const catalogs = new Map<string, readonly string[]>();
    const provider = await startModelProviderShim(({ messages, toolNames }) => {
      if (toolNames.length === 0) {
        return { finalText: 'Reset inventory verification' };
      }
      const currentUser = messages.findLast(
        (value) => value && typeof value === 'object' && 'role' in value && value.role === 'user'
      );
      if (!currentUser) {
        throw new Error('Reset inventory probe requires a native user message.');
      }
      const current = JSON.stringify(currentUser);
      const marker = [ENABLED_PROBE, DISABLED_PROBE, RESTORED_PROBE].find((value) =>
        current.includes(value)
      );
      if (!marker) {
        throw new Error('Unexpected native provider probe');
      }
      catalogs.set(marker, [...toolNames]);
      return { finalText: `${marker} complete` };
    });
    const environment = {
      BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
      BRAINSTRIKE_OPENROUTER_API_KEY: 'isolated-reset-provider-key',
      OPENROUTER_BASE_URL: provider.baseUrl,
    };
    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]])
    );
    Object.assign(process.env, environment);
    const failures: unknown[] = [];
    const hostErrors: string[] = [];
    const attachProviderCatalogs = async (): Promise<void> => {
      try {
        await testInfo.attach('delegation-provider-catalogs', {
          body: JSON.stringify(Object.fromEntries(catalogs), null, 2),
          contentType: 'application/json',
        });
      } catch (error) {
        failures.push(error);
      }
    };
    let page: Page | undefined;
    try {
      (await electron.ensureContext()).app
        .process()
        .stderr?.on('data', (chunk: Buffer) => hostErrors.push(chunk.toString()));
      page = await electron.ensureWindow();
      await ensureMockWorkspaceOpen(page);
      await configureAssistantProvider(page, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await sendInventoryProbe(page, ENABLED_PROBE);
      expect(catalogs.get(ENABLED_PROBE)).toContain('agent-worker');
      await openSubagents(page);
      const toggle = page.getByTestId('subagent-delegation-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await sendInventoryProbe(page, DISABLED_PROBE);
      const disabled = catalogs.get(DISABLED_PROBE);
      expect(disabled).toContain('search_tools');
      expect(disabled?.filter((name) => name.startsWith('agent-'))).toEqual([]);
      await waitForDatabaseReady(page);
      const seed = await seedDelegatedResetState(page);
      await page.reload();
      await ensureAssistantShellVisible(page);
      await page
        .getByTestId('thread-row')
        .getByRole('button')
        .filter({ has: page.getByText('Delegated reset root', { exact: true }) })
        .click();
      await expect(page.getByRole('tab', { exact: true, name: 'Reset Cedar' })).toBeVisible();
      await expect(page.getByText('Reset child durable evidence', { exact: true })).toBeVisible();
      await new HomePage(page).openSettings();
      await new SettingsPage(page).openCategory(/Factory Reset/i, 'factory-reset');
      const beforeCancel = await readDelegatedResetState(page, seed);
      expect(Object.entries(beforeCancel).filter(([, rows]) => rows.length === 0)).toEqual([]);
      await confirmReset(page, false);
      expect(await readDelegatedResetState(page, seed)).toEqual(beforeCancel);
      await openSubagents(page);
      await expect(page.getByTestId('subagent-delegation-toggle')).toHaveAttribute(
        'aria-checked',
        'false'
      );
      await new SettingsPage(page).openCategory(/Factory Reset/i, 'factory-reset');
      const reloaded = page.waitForEvent('load');
      await confirmReset(page, true);
      await reloaded;
      await waitForDatabaseReady(page);
      expect(
        Object.entries(await readDelegatedResetState(page, seed)).filter(
          ([, rows]) => rows.length > 0
        )
      ).toEqual([]);
      await expect(page.getByRole('tab', { exact: true, name: 'Reset Cedar' })).toHaveCount(0);
      await openSubagents(page);
      await expect(page.getByTestId('subagent-delegation-toggle')).toHaveAttribute(
        'aria-checked',
        'true'
      );
      expect(await readFile(sentinel, 'utf8')).toBe('USER_WORKSPACE_MUST_SURVIVE_RESET\n');
      const restarted = await electron.restart();
      page = restarted.window;
      restarted.app
        .process()
        .stderr?.on('data', (chunk: Buffer) => hostErrors.push(chunk.toString()));
      await waitForDatabaseReady(page);
      expect(
        Object.entries(await readDelegatedResetState(page, seed)).filter(
          ([, rows]) => rows.length > 0
        )
      ).toEqual([]);
      await expect(page.getByRole('tab', { exact: true, name: 'Reset Cedar' })).toHaveCount(0);
      await openSubagents(page);
      await expect(page.getByTestId('subagent-delegation-toggle')).toHaveAttribute(
        'aria-checked',
        'true'
      );
      expect(await readFile(sentinel, 'utf8')).toBe('USER_WORKSPACE_MUST_SURVIVE_RESET\n');
      await ensureMockWorkspaceOpen(page);
      await configureAssistantProvider(page, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await sendInventoryProbe(page, RESTORED_PROBE);
      expect(catalogs.get(RESTORED_PROBE)).toContain('agent-worker');
      await attachProviderCatalogs();
    } catch (error) {
      failures.push(error);
      if (page && !page.isClosed()) {
        try {
          await testInfo.attach('delegated-reset-failure-dom', {
            body: await page.content(),
            contentType: 'text/html',
          });
          await testInfo.attach('delegated-reset-failure-screen', {
            body: await page.screenshot(),
            contentType: 'image/png',
          });
        } catch (captureError) {
          failures.push(captureError);
        }
      }
      await attachProviderCatalogs();
    }
    let disposed = false;
    for (const cleanup of [
      async () => {
        await electron.dispose();
        disposed = true;
      },
      provider.close,
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const key of Object.keys(environment)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
    if (disposed) {
      try {
        await rm(workspace, { force: true, recursive: true });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      expect(hostErrors.join('')).not.toContain('Error occurred in handler for');
      expect(hostErrors.join('')).not.toContain(
        'Runtime status must not include non-canonical status field'
      );
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Delegated reset release verification failed');
    }
  }
);
