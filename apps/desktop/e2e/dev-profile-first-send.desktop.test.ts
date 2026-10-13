import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createServer } from 'vite';
import { HomePage } from './page-objects/home-page';
import { startModelProviderShim } from './utils/model-provider-shim';
import {
  launchOrdinaryDevApp,
  type OrdinaryDevApp,
  ordinaryDevLaunchConfiguration,
  prepareOrdinaryDevApp,
} from './utils/ordinary-dev-app';

async function newThread(page: Page): Promise<void> {
  const tabs = page.getByRole('tablist', { name: 'Open assistant threads' });
  const previous = await tabs.getByRole('tab', { selected: true }).getAttribute('aria-controls');
  await page.getByRole('button', { exact: true, name: 'New assistant thread' }).click();
  await expect
    .poll(() => tabs.getByRole('tab', { selected: true }).getAttribute('aria-controls'))
    .not.toBe(previous);
}

async function send(page: Page, message: string): Promise<void> {
  const selected = await page
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab', { selected: true })
    .getAttribute('aria-controls');
  if (!selected) {
    throw new Error('No active conversation');
  }
  const conversation = page.getByTestId(selected);
  await conversation.getByRole('textbox', { name: 'Message input' }).fill(message);
  await conversation.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(conversation.getByText('DEV_PROFILE_REPLY', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert', { name: 'Agent command error' })).toHaveCount(0);
}

async function configureProvider(page: Page, save: boolean): Promise<void> {
  const home = new HomePage(page);
  await home.openSettings();
  await page
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('button', { exact: true, name: 'Providers' })
    .click();
  await page.getByTestId('provider-card-toggle-openrouter').click();
  if (save) {
    await page.getByTestId('credential-set-openrouter').click();
    await page.getByTestId('credential-key-input-openrouter').fill('sk-or-test-dev-profile');
    await page.keyboard.press('Enter');
  }
  await expect(page.getByTestId('credential-status-openrouter')).toContainText('Stored');
  await expect(page.getByTestId('provider-connection-openrouter')).toHaveAttribute(
    'data-connection',
    'connected'
  );
  await home.leaveSettings();
}

async function chooseModel(page: Page): Promise<void> {
  await page.getByRole('button', { exact: true, name: 'Selected model: none' }).click();
  await page.getByRole('option').filter({ hasText: 'GPT-5.6 Terra (OpenRouter)' }).first().click();
}

async function addRoot(page: Page): Promise<string> {
  await page.getByRole('button', { exact: true, name: 'Add Folder to Workspace' }).click();
  await expect(page.getByTestId('single-root-header-row')).toContainText('brainstrike');
  const roots = await page.evaluate(async () => {
    if (!window.electronAPI) {
      throw new Error('Desktop bridge unavailable');
    }
    return (await window.electronAPI.fileSystem.restoreRoots()).map((root) => ({
      id: root.rootId,
      permissionState: root.permissionState,
    }));
  });
  expect(roots).toHaveLength(1);
  expect(roots[0]?.permissionState).toBe('granted');
  const id = roots[0]?.id;
  if (!id) {
    throw new Error('Actual picker did not register a root');
  }
  return id;
}

// Incident: ordinary development shared grants/UI across per-branch databases.
// A Add/disconnect, B Add same path, A return selected B while admission owned A.
// Existing --test-mode/seedRoot tests bypassed the effective normal-dev scope.
test('ordinary dev isolates profile grants and first Send across A/B/A and full reopen', async ({}, info) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bs-normal-dev-profiles-'));
  const root = path.join(directory, 'brainstrike');
  await mkdir(root);
  await writeFile(path.join(root, 'README.md'), 'Disposable normal development root.\n');
  const application = await prepareOrdinaryDevApp(directory);
  const provider = await startModelProviderShim({
    finalText: 'DEV_PROFILE_REPLY',
    verifyOpenRouterKey: true,
  });
  const server = await createServer({
    configFile: path.resolve('vite.config.mts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  let current: OrdinaryDevApp | undefined;
  const paths: Record<string, string> = {};
  try {
    await server.listen();
    const rendererUrl = server.resolvedUrls?.local[0];
    if (!rendererUrl) {
      throw new Error('Dev renderer URL unavailable');
    }
    const launch = async (profile: string): Promise<OrdinaryDevApp> => {
      const app = await launchOrdinaryDevApp({
        application,
        directory,
        profile,
        provider,
        rendererUrl,
        root,
      });
      current = app;
      return app;
    };
    const close = async (): Promise<void> => {
      await current?.close();
      current = undefined;
    };

    const a = await launch('incident-a');
    paths['a'] = a.userData;
    await configureProvider(a.page, true);
    await chooseModel(a.page);
    await send(a.page, 'A_NO_FOLDER');
    const rootA = await addRoot(a.page);
    await newThread(a.page);
    await send(a.page, 'A_WITH_FOLDER');

    // The shared credential owner retains the original one-dev-app exclusion,
    // even though Chromium/workspace state belongs to distinct DB profiles.
    const credentialPath = path.join(
      directory,
      'shared-launch-user-data/brainstrike-credentials.json'
    );
    const credentialDigest = async (): Promise<string> =>
      createHash('sha256')
        .update(await readFile(credentialPath))
        .digest('hex');
    const beforeCredentials = await credentialDigest();
    await a.app.evaluate(({ app }) => {
      app.once('second-instance', () => {
        Reflect.set(globalThis, '__devSecondInstanceObserved', true);
      });
    });
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') {
      throw new Error('Electron executable unavailable');
    }
    const concurrent = await ordinaryDevLaunchConfiguration({
      application,
      directory,
      profile: 'incident-b',
      provider,
      rendererUrl,
      root,
    });
    const second = spawn(executable, concurrent.args, { env: concurrent.env, stdio: 'ignore' });
    const secondExit = once(second, 'exit');
    try {
      await expect.poll(() => second.exitCode).toBe(0);
      await secondExit;
      expect(second.signalCode).toBeNull();
      await expect
        .poll(() => a.app.evaluate(() => Reflect.get(globalThis, '__devSecondInstanceObserved')))
        .toBe(true);
      expect(existsSync(path.join(directory, 'database/profiles/incident-b'))).toBe(false);
      expect(await credentialDigest()).toBe(beforeCredentials);
      expect(a.app.process().exitCode).toBeNull();
    } finally {
      if (second.exitCode === null && second.signalCode === null) {
        second.kill('SIGTERM');
        await secondExit;
      }
    }
    await close();

    const reopenedA = await launch('incident-a');
    expect(reopenedA.userData).toBe(paths['a']);
    await expect(
      reopenedA.page
        .getByTestId('assistant-ui-viewport')
        .getByText('A_WITH_FOLDER', { exact: true })
    ).toBeVisible();
    await reopenedA.page.getByTestId('single-root-header-row').click({ button: 'right' });
    await reopenedA.page.getByRole('menuitem', { exact: true, name: 'Disconnect…' }).click();
    await reopenedA.page
      .getByRole('dialog')
      .getByRole('button', { exact: true, name: 'Disconnect' })
      .click();
    await expect(reopenedA.page.getByTestId('single-root-header-row')).toHaveCount(0);
    await close();

    const b = await launch('incident-b');
    paths['b'] = b.userData;
    expect(b.userData).not.toBe(paths['a']);
    await expect(b.page.getByTestId('single-root-header-row')).toHaveCount(0);
    await expect(
      b.page.getByTestId('assistant-ui-viewport').getByText('A_WITH_FOLDER', { exact: true })
    ).toHaveCount(0);
    await configureProvider(b.page, false);
    await chooseModel(b.page);
    await send(b.page, 'B_NO_FOLDER');
    const rootB = await addRoot(b.page);
    expect(rootB).not.toBe(rootA);
    await newThread(b.page);
    await send(b.page, 'B_WITH_FOLDER');
    await close();

    const returnedA = await launch('incident-a');
    expect(returnedA.userData).toBe(paths['a']);
    await expect(returnedA.page.getByTestId('single-root-header-row')).toHaveCount(0);
    await expect(
      returnedA.page
        .getByTestId('assistant-ui-viewport')
        .getByText('B_WITH_FOLDER', { exact: true })
    ).toHaveCount(0);
    const restoredA = await addRoot(returnedA.page);
    expect(restoredA).toBe(rootA);
    await newThread(returnedA.page);
    await send(returnedA.page, 'A_RETURN_FIRST_SEND');
    await close();

    const finalA = await launch('incident-a');
    await expect(
      finalA.page
        .getByTestId('assistant-ui-viewport')
        .getByText('A_RETURN_FIRST_SEND', { exact: true })
    ).toBeVisible();
    await expect(finalA.page.getByRole('alert', { name: 'Agent command error' })).toHaveCount(0);
    expect(provider.refusals()).toEqual([]);
    await info.attach('normal-dev-profile-paths', {
      body: JSON.stringify(paths),
      contentType: 'application/json',
    });
  } catch (error) {
    if (current && !current.page.isClosed()) {
      await info.attach('normal-dev-failure', {
        body: await current.page.screenshot(),
        contentType: 'image/png',
      });
    }
    throw error;
  } finally {
    await current?.close();
    await server.close();
    await provider.close();
    // Keep disposable failure/runtime receipts available; never remove a live profile.
  }
});
