import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { HomePage } from './page-objects/home-page';
import { readCommittedRuns, waitForAppHost } from './utils/agent-host-log';
import { type ModelProviderShim, startModelProviderShim } from './utils/model-provider-shim';
import { startThread } from './utils/new-thread';
import {
  launchOrdinaryDevApp,
  type OrdinaryDevApp,
  ordinaryDevLaunchConfiguration,
  prepareOrdinaryDevApp,
} from './utils/ordinary-dev-app';
import { runViteCache } from './utils/run-vite-cache';

/** Each send here is a thread's first: it creates the thread from the new-thread screen. */
async function send(page: Page, message: string): Promise<void> {
  const conversation = await startThread(page, message);
  await expect(conversation.getByText('DEV_PROFILE_REPLY', { exact: true })).toBeVisible();
  // The reply streams before the host commits the run's end; the pane leaves the
  // running state once that end is committed.
  await expect(conversation.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
  await expect(page.getByRole('alert', { name: 'Agent command error' })).toHaveCount(0);
}

async function configureProvider(page: Page): Promise<void> {
  const home = new HomePage(page);
  await home.openSettings();
  await page
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('button', { exact: true, name: 'Providers' })
    .click();
  await page.getByTestId('provider-card-toggle-openrouter').click();
  // The agent host is the only credential writer, and a save waits while it starts.
  await waitForAppHost(page);
  await page.getByTestId('credential-set-openrouter').click();
  await page.getByTestId('credential-key-input-openrouter').fill('sk-or-test-dev-profile');
  await page.keyboard.press('Enter');
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

async function disconnectRoot(page: Page): Promise<void> {
  await page.getByTestId('single-root-header-row').click({ button: 'right' });
  await page.getByRole('menuitem', { exact: true, name: 'Disconnect…' }).click();
  await page.getByRole('dialog').getByRole('button', { exact: true, name: 'Disconnect' }).click();
  await expect(page.getByTestId('single-root-header-row')).toHaveCount(0);
}

async function addRoot(page: Page): Promise<string> {
  await page.getByRole('button', { exact: true, name: 'Add Folder to Workspace' }).click();
  await expect(page.getByTestId('single-root-header-row')).toContainText('brainstrike');
  const roots = await page.evaluate(async () => {
    if (!window.electronAPI) {
      throw new Error('Desktop bridge unavailable');
    }
    const reply = await window.electronAPI.fileSystem.restoreRoots();
    if (!reply.ok) {
      throw new Error(reply.error.message);
    }
    return reply.value.map((root) => ({
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

interface OrdinaryDev {
  readonly application: string;
  readonly close: () => Promise<void>;
  readonly directory: string;
  /** Launches a profile; the previous app must be closed first. */
  readonly launch: (profile: string) => Promise<OrdinaryDevApp>;
  readonly provider: ModelProviderShim;
  readonly rendererUrl: string;
  readonly root: string;
}

// Each launch is a whole ordinary dev app with an unbundled dev renderer: about
// 5 s on Linux and 15-35 s on hosted 2-vCPU Windows, so one test of five launches
// outran its 120 s there. No test below holds more than three.
const test = base.extend<{ ordinaryDev: OrdinaryDev }>({
  ordinaryDev: async ({}, use, info) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bs-normal-dev-profiles-'));
    const root = path.join(directory, 'brainstrike');
    await mkdir(root);
    await writeFile(path.join(root, 'README.md'), 'Disposable normal development root.\n');
    const application = await prepareOrdinaryDevApp(info.outputPath('application'));
    const provider = await startModelProviderShim({
      finalText: 'DEV_PROFILE_REPLY',
      verifyOpenRouterKey: true,
    });
    const server = await createServer({
      ...runViteCache(),
      configFile: path.resolve('vite.config.mts'),
      server: { host: '127.0.0.1', port: 0 },
    });
    let current: OrdinaryDevApp | undefined;
    try {
      await server.listen();
      const rendererUrl = server.resolvedUrls?.local[0];
      if (!rendererUrl) {
        throw new Error('Dev renderer URL unavailable');
      }
      await use({
        application,
        close: async () => {
          const app = current;
          current = undefined;
          await app?.close();
        },
        directory,
        launch: async (profile) => {
          if (current) {
            throw new Error('Close the running ordinary dev app before launching another');
          }
          current = await launchOrdinaryDevApp({
            application,
            directory,
            profile,
            provider,
            rendererUrl,
            root,
          });
          return current;
        },
        provider,
        rendererUrl,
        root,
      });
      // A failed test still returns from use(); its live window is the receipt.
      if (info.status !== info.expectedStatus && current && !current.page.isClosed()) {
        await info.attach('normal-dev-failure', {
          body: await current.page.screenshot(),
          contentType: 'image/png',
        });
      }
    } finally {
      await current?.close();
      await server.close();
      await provider.close();
      // Keep disposable failure/runtime receipts available; never remove a live profile.
    }
  },
});

async function selectedThreadId(page: Page): Promise<string> {
  const tab = await page
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab', { selected: true })
    .getAttribute('id');
  if (!tab?.startsWith('assistant-thread-tab-')) {
    throw new Error(`No selected assistant thread tab: ${tab}`);
  }
  return tab.slice('assistant-thread-tab-'.length);
}

// The shared launch lock retains the original one-dev-app exclusion, even though
// Chromium, workspace and credential state belong to distinct DB profiles; a full
// reopen of A keeps its first Sends and its root, which it then disconnects.
test('ordinary dev excludes a second app, then reopens A with its first Sends and root', async ({
  ordinaryDev,
}) => {
  const a = await ordinaryDev.launch('incident-a');
  await configureProvider(a.page);
  // A fresh profile has no model: the new-thread composer waits for one.
  await chooseModel(a.page);
  await send(a.page, 'A_NO_FOLDER');
  await addRoot(a.page);
  await send(a.page, 'A_WITH_FOLDER');

  const credentialPath = path.join(a.userData, 'brainstrike-credentials.json');
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
    application: ordinaryDev.application,
    directory: ordinaryDev.directory,
    profile: 'incident-b',
    provider: ordinaryDev.provider,
    rendererUrl: ordinaryDev.rendererUrl,
    root: ordinaryDev.root,
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
    expect(existsSync(path.join(ordinaryDev.directory, 'database/profiles/incident-b'))).toBe(
      false
    );
    expect(await credentialDigest()).toBe(beforeCredentials);
    expect(a.app.process().exitCode).toBeNull();
  } finally {
    if (second.exitCode === null && second.signalCode === null) {
      second.kill('SIGTERM');
      await secondExit;
    }
  }
  await ordinaryDev.close();

  const reopenedA = await ordinaryDev.launch('incident-a');
  expect(reopenedA.userData).toBe(a.userData);
  await expect(
    reopenedA.page.getByTestId('assistant-ui-viewport').getByText('A_WITH_FOLDER', { exact: true })
  ).toBeVisible();
  await expect(reopenedA.page.getByTestId('single-root-header-row')).toContainText('brainstrike');
  await disconnectRoot(reopenedA.page);
  await expect(reopenedA.page.getByRole('alert', { name: 'Agent command error' })).toHaveCount(0);
  expect(ordinaryDev.provider.refusals()).toEqual([]);
});

// Incident: ordinary development shared grants/UI across per-branch databases.
// A Add/disconnect, B Add same path, A return selected B while admission owned A.
// Existing --test-mode/seedRoot tests bypassed the effective normal-dev scope.
test('ordinary dev isolates profile grants and first Send across A/B/A', async ({
  ordinaryDev,
}, info) => {
  const a = await ordinaryDev.launch('incident-a');
  await configureProvider(a.page);
  // A fresh profile has no model: the new-thread composer waits for one.
  await chooseModel(a.page);
  await send(a.page, 'A_NO_FOLDER');
  const rootA = await addRoot(a.page);
  await disconnectRoot(a.page);
  await ordinaryDev.close();

  const b = await ordinaryDev.launch('incident-b');
  expect(b.userData).not.toBe(a.userData);
  await expect(b.page.getByTestId('single-root-header-row')).toHaveCount(0);
  await expect(
    b.page.getByTestId('assistant-ui-viewport').getByText('A_NO_FOLDER', { exact: true })
  ).toHaveCount(0);
  // Each profile keeps its own credentials, so B saves its own key.
  await configureProvider(b.page);
  await chooseModel(b.page);
  await send(b.page, 'B_NO_FOLDER');
  const rootB = await addRoot(b.page);
  expect(rootB).not.toBe(rootA);
  await send(b.page, 'B_WITH_FOLDER');
  await ordinaryDev.close();

  const returnedA = await ordinaryDev.launch('incident-a');
  expect(returnedA.userData).toBe(a.userData);
  await expect(returnedA.page.getByTestId('single-root-header-row')).toHaveCount(0);
  for (const text of ['B_NO_FOLDER', 'B_WITH_FOLDER']) {
    await expect(
      returnedA.page.getByTestId('assistant-ui-viewport').getByText(text, { exact: true })
    ).toHaveCount(0);
  }
  const restoredA = await addRoot(returnedA.page);
  expect(restoredA).toBe(rootA);
  await send(returnedA.page, 'A_RETURN_FIRST_SEND');
  // A's own host committed the first Send after return. The host publishes its
  // record in the profile's database root, beside Electron's per-profile userData.
  const hostRoot = path.join(ordinaryDev.directory, 'database/profiles/incident-a');
  const threadId = await selectedThreadId(returnedA.page);
  expect((await readCommittedRuns(hostRoot, threadId)).map((run) => run.status)).toEqual([
    'completed',
  ]);
  await expect(returnedA.page.getByRole('alert', { name: 'Agent command error' })).toHaveCount(0);
  expect(ordinaryDev.provider.refusals()).toEqual([]);
  await info.attach('normal-dev-profile-paths', {
    body: JSON.stringify({ a: a.userData, b: b.userData }),
    contentType: 'application/json',
  });
});
