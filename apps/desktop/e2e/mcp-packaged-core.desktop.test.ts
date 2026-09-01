import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestInfo } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';
import {
  closePackagedDesktop,
  launchPackagedDesktop,
  packagedDesktopExecutablePath,
} from './utils/packaged-electron';

interface FixtureManifest {
  readonly authentication: 'none' | 'oauth';
  readonly authorizationUrl?: string;
  readonly protocolVersion: '2025-11-25' | '2026-07-28';
  readonly transport: 'streamable-http';
  readonly url: string;
}

interface FixtureCleanupReport {
  readonly clean: boolean;
  readonly httpListenersClosed: number;
  readonly oauthState?: Readonly<Record<'clients' | 'codes' | 'states' | 'tokens', number>>;
}

interface PackagedFixture {
  authorizationDelayObserved(): boolean;
  close(): Promise<FixtureCleanupReport>;
  readonly manifest: FixtureManifest;
}

interface PackagedFixtureModule {
  startPackagedCoreFixture(
    id: 'legacy-reference' | 'modern-reference' | 'oauth-reference',
    options?: { readonly authorizationDelayMs?: number }
  ): Promise<PackagedFixture>;
}

interface PackagedContext {
  readonly app: ElectronApplication;
  readonly window: Page;
}

function fixtureModulePath(): string {
  return pathToFileURL(path.resolve(process.cwd(), '../../packages/mcp-test-lab/dist/index.js'))
    .href;
}

async function loadFixtures(): Promise<PackagedFixtureModule> {
  return (await import(fixtureModulePath())) as unknown as PackagedFixtureModule;
}

function stdioFixturePath(): string {
  return path.resolve(
    process.cwd(),
    '../../packages/mcp-test-lab/fixtures/stdio-reference-server.mjs'
  );
}

function buildConfig(options: {
  readonly diagnosticControlPath: string;
  readonly diagnosticPidFile: string;
  readonly legacyUrl: string;
  readonly modernUrl: string;
  readonly oauthCancelUrl: string;
  readonly oauthUrl: string;
  readonly stdioPidFile: string;
}): string {
  return JSON.stringify(
    {
      servers: [
        {
          name: 'modern',
          protocol: '2026-07-28',
          transport: 'streamable-http',
          url: options.modernUrl,
        },
        {
          name: 'legacy',
          protocol: 'legacy',
          transport: 'streamable-http',
          url: options.legacyUrl,
        },
        {
          args: [
            stdioFixturePath(),
            '--brainstrike-production-env',
            `--brainstrike-pid-file=${options.stdioPidFile}`,
          ],
          command: process.execPath,
          env: { BRAINSTRIKE_STDIO_FIXTURE: '1' },
          name: 'stdio',
          protocol: '2026-07-28',
          transport: 'stdio',
        },
        {
          auth: { type: 'oauth-user' },
          name: 'oauth-cancel',
          protocol: '2026-07-28',
          startup: 'authentication-required',
          transport: 'streamable-http',
          url: options.oauthCancelUrl,
        },
        {
          auth: { type: 'oauth-user' },
          name: 'oauth',
          protocol: '2026-07-28',
          startup: 'authentication-required',
          transport: 'streamable-http',
          url: options.oauthUrl,
        },
        {
          args: [
            stdioFixturePath(),
            '--brainstrike-production-env',
            `--brainstrike-fault-control=${options.diagnosticControlPath}`,
            `--brainstrike-pid-file=${options.diagnosticPidFile}`,
          ],
          command: process.execPath,
          env: { BRAINSTRIKE_STDIO_FIXTURE: '1' },
          name: 'diagnostic-stdio',
          protocol: '2026-07-28',
          transport: 'stdio',
        },
      ],
    },
    null,
    2
  );
}

async function openToolsSettings(page: Page): Promise<void> {
  const home = new HomePage(page);
  const settings = new SettingsPage(page);
  await home.openSettings();
  await settings.openCategory(/AI Tools/i, 'ai-tools');
  await page.getByRole('tab', { name: 'MCP Config' }).click();
  await expect(page.getByTestId('mcp-config-editor-panel')).toBeVisible({ timeout: 30_000 });
}

async function configureThroughUi(page: Page, config: string): Promise<void> {
  await openToolsSettings(page);
  const editor = page.getByTestId('mcp-config-editor');
  await editor.fill(config);
  await page.getByTestId('mcp-config-save').click();
  await expect(page.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await page.getByRole('tab', { name: 'Tools' }).click();
}

async function openToolsStatus(page: Page): Promise<void> {
  await openToolsSettings(page);
  await page.getByRole('tab', { name: 'Tools' }).click();
}

function serverRow(page: Page, id: string) {
  return page
    .getByTestId('mcp-server-status-list')
    .getByText(id, { exact: true })
    .locator('..')
    .locator('..');
}

async function waitForServerState(page: Page, id: string, state: RegExp): Promise<void> {
  await expect(serverRow(page, id)).toContainText(state, { timeout: 60_000 });
}

async function sendDiagnosticCommand(
  controlDirectory: string,
  sequence: number,
  command: 'exit' | 'stderr'
): Promise<void> {
  const id = String(sequence).padStart(6, '0');
  await writeFile(path.join(controlDirectory, `command-${id}-${command}`), '', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await expect
    .poll(
      async () =>
        await access(path.join(controlDirectory, `ack-${id}`)).then(
          () => true,
          () => false
        ),
      { timeout: 10_000 }
    )
    .toBe(true);
}

async function verifyDiagnosticFailure(page: Page, controlDirectory: string): Promise<void> {
  await waitForServerState(page, 'diagnostic-stdio', /Connected/i);
  await sendDiagnosticCommand(controlDirectory, 2, 'stderr');
  await sendDiagnosticCommand(controlDirectory, 3, 'exit');
  await waitForServerState(page, 'diagnostic-stdio', /Error/i);
  await expect(page.getByTestId('mcp-diagnostics-diagnostic-stdio')).toContainText(
    '[redacted-secret:bearer-token]'
  );
  await expect(serverRow(page, 'diagnostic-stdio')).not.toContainText('bst-1577-secret');
}

async function connectOAuthThroughNativeBrowser(
  page: Page,
  cancellationFixture: PackagedFixture
): Promise<void> {
  await page.getByRole('button', { name: 'Connect oauth-cancel' }).click();
  await expect
    .poll(
      async () =>
        cancellationFixture.authorizationDelayObserved()
          ? 'authorization-observed'
          : ((await serverRow(page, 'oauth-cancel').textContent()) ?? 'missing-server-row'),
      { timeout: 30_000 }
    )
    .toBe('authorization-observed');
  await page.evaluate(async () => {
    const control = (
      window as unknown as {
        mcp?: {
          controlServer?: (request: {
            action: 'cancel';
            configuredServerId: string;
          }) => Promise<unknown>;
        };
      }
    ).mcp?.controlServer;
    if (!control) {
      throw new Error('Packaged MCP lifecycle bridge is unavailable');
    }
    await control({ action: 'cancel', configuredServerId: 'oauth-cancel' });
  });
  await waitForServerState(page, 'oauth-cancel', /authentication-required|disconnected/i);
  await page.getByRole('button', { exact: true, name: 'Connect oauth' }).click();
  await waitForServerState(page, 'oauth', /Connected/i);
  await expect(serverRow(page, 'oauth')).toContainText('2026-07-28');
}

async function requireMcpApprovalThroughUi(page: Page): Promise<void> {
  const settings = new SettingsPage(page);
  await settings.openCategory(/Permissions/i, 'permissions');
  const policy = page.getByRole('combobox', { name: 'MCP permission' });
  await policy.selectOption('ask');
  await expect(policy).toHaveValue('ask');
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return true;
    }
    throw error;
  }
}

async function readOwnedPid(pidFile: string): Promise<number> {
  let pid = 0;
  await expect
    .poll(
      async () => {
        const value = await readFile(pidFile, 'utf8').catch(() => '');
        pid = Number.parseInt(value.trim(), 10);
        return Number.isSafeInteger(pid) && pid > 0;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  return pid;
}

async function expectOwnedProcessGone(pid: number): Promise<void> {
  await expect.poll(() => processIsGone(pid), { timeout: 30_000 }).toBe(true);
}

async function executeAssistantTool(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await configureAssistantProvider(page, {
    compositeModelKey: 'openrouter::openai/gpt-5.4',
    provider: 'openrouter',
  });
  await ensureAssistantShellVisible(page);
  const input = page.locator('#assistant-input');
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill('Run the packaged modern MCP proof.');
  await page.getByRole('button', { exact: true, name: 'Send' }).click();
  const approval = page.getByTestId('assistant-tool-approval-notice');
  const completed = page.getByText('Packaged MCP tool completed.').first();
  const outcome = await Promise.race([
    approval.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'approval' as const),
    completed.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'completed' as const),
  ]);
  if (outcome === 'completed') {
    await page.getByRole('button', { exact: true, name: 'Expand details' }).click();
    const transcript = await page.getByRole('region', { name: 'Assistant chat' }).innerText();
    throw new Error(`MCP tool bypassed approval or failed before suspension: ${transcript}`);
  }
  await approval.getByRole('button', { name: /Approve/u }).click();
  await expect(completed).toBeVisible({ timeout: 90_000 });
  const toolCard = page
    .getByTestId('tool-fallback')
    .filter({ hasText: 'modern.test_simple_text' })
    .last();
  await expect(toolCard.getByRole('img', { name: 'Completed' })).toBeVisible();
  await toolCard.getByRole('button', { exact: true, name: 'Expand details' }).click();
  await expect(toolCard).toContainText('This is a simple text response for testing.');
}

async function findDurableDiagnostic(userDataDir: string): Promise<string> {
  const logsDirectory = path.join(userDataDir, 'logs');
  const entries = await readdir(logsDirectory);
  const diagnosticName = entries.find((entry) => entry.endsWith('.ndjson'));
  if (!diagnosticName) {
    throw new Error('Packaged MCP proof did not create a durable NDJSON diagnostic log');
  }
  return await readFile(path.join(logsDirectory, diagnosticName), 'utf8');
}

async function attachFailureDiagnostics(
  testFailed: boolean,
  testInfo: TestInfo,
  userDataDir: string
): Promise<void> {
  if (!testFailed) {
    return;
  }
  const logsDirectory = path.join(userDataDir, 'logs');
  const entries = await readdir(logsDirectory).catch(() => []);
  for (const entry of entries.filter((candidate) => candidate.endsWith('.ndjson'))) {
    const contents = await readFile(path.join(logsDirectory, entry), 'utf8');
    await testInfo.attach(`sanitized-${entry}`, {
      body: contents.slice(-256_000),
      contentType: 'application/x-ndjson',
    });
  }
}

async function performFactoryReset(page: Page): Promise<void> {
  await openToolsSettings(page);
  const home = new HomePage(page);
  const settings = new SettingsPage(page);
  await home.openSettings();
  await settings.openCategory(/Factory Reset/i, 'factory-reset');
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  await page.getByTestId('factory-reset-button').click();
  await expect(page.getByRole('heading', { exact: true, name: 'Settings' })).toHaveCount(0, {
    timeout: 30_000,
  });
}

test('packaged renderer reaches the production MCP host, OAuth, assistant, and cleanup paths', async ({}, testInfo) => {
  test.setTimeout(420_000);
  await access(packagedDesktopExecutablePath(), constants.X_OK);
  await access(stdioFixturePath(), constants.R_OK);
  const fixtureModule = await loadFixtures();
  const [modern, legacy, oauthCancel, oauth] = await Promise.all([
    fixtureModule.startPackagedCoreFixture('modern-reference'),
    fixtureModule.startPackagedCoreFixture('legacy-reference'),
    fixtureModule.startPackagedCoreFixture('oauth-reference', { authorizationDelayMs: 10_000 }),
    fixtureModule.startPackagedCoreFixture('oauth-reference'),
  ]);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bst-1577-packaged-user-data-'));
  const fixtureStateDir = await mkdtemp(path.join(os.tmpdir(), 'bst-1577-fixture-state-'));
  const diagnosticControlDirectory = path.join(fixtureStateDir, 'diagnostic-control');
  const diagnosticControlPath = path.join(diagnosticControlDirectory, 'configuration.json');
  const diagnosticPidFile = path.join(fixtureStateDir, 'diagnostic-stdio.pid');
  const stdioPidFile = path.join(fixtureStateDir, 'stdio.pid');
  await mkdir(diagnosticControlDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      diagnosticControlPath,
      JSON.stringify({
        exitArmed: true,
        exitCode: 1,
        stderrText:
          'Authorization: Bearer bst-1577-secret-bearer ' +
          'https://auth.invalid/callback?code=bst-1577-secret-code&state=bst-1577-secret-state\n',
      }),
      { encoding: 'utf8', mode: 0o600 }
    ),
    writeFile(path.join(diagnosticControlDirectory, 'command-000001-start-mcp'), '', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    }),
  ]);
  const modelProvider = await startModelProviderShim({
    discoveryQuery: 'modern test simple text',
    finalText: 'Packaged MCP tool completed.',
    toolCall: { arguments: {}, name: 'modern_test_simple_text' },
  });
  let first: PackagedContext | undefined;
  let firstStdioPid: number | undefined;
  let restarted: PackagedContext | undefined;
  let restartedStdioPid: number | undefined;
  let testFailed = false;
  let fixtureReports: readonly FixtureCleanupReport[] = [];
  try {
    first = await launchPackagedDesktop({
      environment: {
        BRAINSTRIKE_OPENROUTER_API_KEY: 'packaged-e2e-provider-key',
        OPENROUTER_BASE_URL: modelProvider.baseUrl,
      },
      userDataDir,
    });
    expect(await first.app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await configureThroughUi(
      first.window,
      buildConfig({
        diagnosticControlPath,
        diagnosticPidFile,
        legacyUrl: legacy.manifest.url,
        modernUrl: modern.manifest.url,
        oauthCancelUrl: oauthCancel.manifest.url,
        oauthUrl: oauth.manifest.url,
        stdioPidFile,
      })
    );
    await waitForServerState(first.window, 'modern', /Connected/i);
    await expect(serverRow(first.window, 'modern')).toContainText('2026-07-28');
    await waitForServerState(first.window, 'legacy', /Connected/i);
    await expect(serverRow(first.window, 'legacy')).toContainText('2025-11-25');
    await waitForServerState(first.window, 'stdio', /Connected/i);
    firstStdioPid = await readOwnedPid(stdioPidFile);
    await verifyDiagnosticFailure(first.window, diagnosticControlDirectory);
    await expectOwnedProcessGone(await readOwnedPid(diagnosticPidFile));

    await connectOAuthThroughNativeBrowser(first.window, oauthCancel);
    await requireMcpApprovalThroughUi(first.window);
    await executeAssistantTool(first.window);
    await openToolsStatus(first.window);
    const disconnect = first.window.getByRole('button', {
      exact: true,
      name: 'Disconnect oauth',
    });
    await disconnect.click();
    await first.window
      .getByRole('button', { exact: true, name: 'Confirm disconnect oauth' })
      .click();
    await expect(disconnect).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    await waitForServerState(first.window, 'oauth', /authentication-required/i);

    await closePackagedDesktop(first);
    first = undefined;
    await expectOwnedProcessGone(firstStdioPid);
    const durableBeforeRestart = await findDurableDiagnostic(userDataDir);
    expect(durableBeforeRestart).toContain('MCP stdio failure diagnostics');
    expect(durableBeforeRestart).not.toContain('bst-1577-secret');

    restarted = await launchPackagedDesktop({
      environment: {
        BRAINSTRIKE_OPENROUTER_API_KEY: 'packaged-e2e-provider-key',
        OPENROUTER_BASE_URL: modelProvider.baseUrl,
      },
      userDataDir,
    });
    expect(await restarted.app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await openToolsStatus(restarted.window);
    await waitForServerState(restarted.window, 'modern', /Connected/i);
    await expect(serverRow(restarted.window, 'modern')).toContainText('2026-07-28');
    await waitForServerState(restarted.window, 'stdio', /Connected/i);
    restartedStdioPid = await readOwnedPid(stdioPidFile);
    expect(restartedStdioPid).not.toBe(firstStdioPid);
    await waitForServerState(restarted.window, 'oauth', /authentication-required/i);
    await expect(serverRow(restarted.window, 'oauth')).toContainText(
      'OAuth credentials not stored'
    );
    expect(await findDurableDiagnostic(userDataDir)).toContain('MCP stdio failure diagnostics');
    await performFactoryReset(restarted.window);
  } catch (error: unknown) {
    testFailed = true;
    throw error;
  } finally {
    if (first) {
      await closePackagedDesktop(first);
    }
    if (restarted) {
      await closePackagedDesktop(restarted);
    }
    if (firstStdioPid !== undefined) {
      await expectOwnedProcessGone(firstStdioPid);
    }
    if (restartedStdioPid !== undefined) {
      await expectOwnedProcessGone(restartedStdioPid);
    }
    fixtureReports = await Promise.all([
      modern.close(),
      legacy.close(),
      oauthCancel.close(),
      oauth.close(),
    ]);
    await modelProvider.close();
    await attachFailureDiagnostics(testFailed, testInfo, userDataDir);
    await rm(fixtureStateDir, { force: true, recursive: true });
    await rm(userDataDir, { force: true, recursive: true });
  }
  expect(fixtureReports).toEqual([
    expect.objectContaining({ clean: true, httpListenersClosed: 1 }),
    expect.objectContaining({ clean: true, httpListenersClosed: 1 }),
    expect.objectContaining({
      clean: true,
      httpListenersClosed: 1,
      oauthState: { clients: 0, codes: 0, states: 0, tokens: 0 },
    }),
    expect.objectContaining({
      clean: true,
      httpListenersClosed: 1,
      oauthState: { clients: 0, codes: 0, states: 0, tokens: 0 },
    }),
  ]);
});
