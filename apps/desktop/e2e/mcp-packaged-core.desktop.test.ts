import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import type { TestInfo } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { Page } from 'playwright';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';
import {
  closePackagedDesktop,
  launchPackagedDesktop,
  PACKAGED_DESKTOP_INHERITED_ENV_KEYS,
  packagedDesktopExecutablePath,
} from './utils/packaged-electron';

interface PackagedFixture {
  authorizationDelayObserved(): boolean;
  authorizationDelaySettled(): boolean;
  close(): Promise<{
    readonly clean: boolean;
    readonly httpListenersClosed: number;
    readonly oauthState?: Readonly<Record<string, number>>;
  }>;
  readonly manifest: { readonly url: string };
}
interface PackagedFixtureModule {
  startPackagedCoreFixture(
    id: 'legacy-reference' | 'modern-reference' | 'oauth-reference',
    options?: { readonly authorizationDelayMs?: number }
  ): Promise<PackagedFixture>;
}
type PackagedContext = Awaited<ReturnType<typeof launchPackagedDesktop>>;
type CloseReport = Record<string, number | readonly unknown[]>;
const ASSISTANT_TOOL_PAYLOAD = 'packaged-assistant-payload';
const ELICITATION_TOOL_PAYLOAD = 'packaged-elicitation-payload';
const OAUTH_BROWSER_DESKTOP_FILE = 'brainstrike-mcp-oauth-browser.desktop';
// BST-1592 content proof coordinates. Kept literal rather than imported from
// the lab source: the packaged proof must fail if the fixture's user-visible
// content drifts, not silently follow it.
const ECHO_RESOURCE_TITLE = 'Echo reference notes';
const ECHO_RESOURCE_URI = 'brainstrike://reference/echo-notes';
const ECHO_RESOURCE_MARKER = 'bst-1592-resource-body';
const ECHO_PROMPT_COMMAND_ID = 'mcp:legacy:echo_prompt';
const ECHO_PROMPT_MENU_LABEL = 'Echo reference prompt · legacy';
const ECHO_PROMPT_ARGUMENT = 'subject';
const ECHO_PROMPT_ARGUMENT_VALUE = 'bst-1592-alpha';
const ECHO_PROMPT_MESSAGE = `Echo the reference subject "${ECHO_PROMPT_ARGUMENT_VALUE}" back to me.`;
async function loadFixtures(): Promise<PackagedFixtureModule> {
  return (await import(
    pathToFileURL(path.resolve(process.cwd(), '../../packages/mcp-test-lab/dist/index.js')).href
  )) as unknown as PackagedFixtureModule;
}
function stdioFixturePath(): string {
  return path.resolve(
    process.cwd(),
    '../../packages/mcp-test-lab/fixtures/stdio-reference-server.mjs'
  );
}
function oauthBrowserFixturePath(): string {
  return path.resolve(
    process.cwd(),
    '../../packages/mcp-test-lab/fixtures/oauth-browser-client.mjs'
  );
}
async function runXdgMime(args: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile('xdg-mime', [...args], { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(new Error('Packaged MCP OAuth browser registration failed', { cause: error }));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}
async function configureLinuxOAuthBrowser(
  fixtureStateDir: string
): Promise<Readonly<Record<string, string>>> {
  if (process.platform !== 'linux') {
    return {};
  }
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
  const xdgDataHome = process.env['XDG_DATA_HOME'];
  if (!(xdgConfigHome && path.isAbsolute(xdgConfigHome))) {
    throw new Error('Packaged MCP OAuth proof requires an isolated XDG_CONFIG_HOME');
  }
  if (!(xdgDataHome && /^\/[A-Za-z0-9._/-]+$/u.test(xdgDataHome))) {
    throw new Error('Packaged MCP OAuth proof requires a shell-safe isolated XDG_DATA_HOME');
  }
  const applicationsDirectory = path.join(xdgDataHome, 'applications');
  const browserPath = path.join(xdgDataHome, 'brainstrike-mcp-oauth-browser');
  await mkdir(applicationsDirectory, { recursive: true });
  await copyFile(oauthBrowserFixturePath(), browserPath);
  await chmod(browserPath, 0o700);
  await writeFile(
    path.join(applicationsDirectory, OAUTH_BROWSER_DESKTOP_FILE),
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Brainstrike MCP OAuth Browser',
      `Exec=${browserPath} %u`,
      'MimeType=x-scheme-handler/http;',
      'NoDisplay=true',
      'Terminal=false',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o644 }
  );
  await runXdgMime(['default', OAUTH_BROWSER_DESKTOP_FILE, 'x-scheme-handler/http']);
  const selectedBrowser = await runXdgMime(['query', 'default', 'x-scheme-handler/http']);
  if (selectedBrowser !== OAUTH_BROWSER_DESKTOP_FILE) {
    throw new Error('Packaged MCP OAuth browser registration did not become authoritative');
  }
  return {
    BRAINSTRIKE_MCP_OAUTH_BROWSER_STATE_FILE: path.join(fixtureStateDir, 'oauth-browser-attempted'),
    XDG_CURRENT_DESKTOP: 'X-Generic',
  };
}
function inheritedStdioEnvironmentArgument(): string {
  const launcherKeys = new Set<string>(PACKAGED_DESKTOP_INHERITED_ENV_KEYS);
  const inheritedKeys = DEFAULT_INHERITED_ENV_VARS.filter(
    (key) => launcherKeys.has(key) && process.env[key] !== undefined
  ).sort();
  return `--brainstrike-expected-inherited-env=${inheritedKeys.join(',')}`;
}
function oauthServer(url: string) {
  return {
    auth: { type: 'oauth-user' },
    name: 'oauth',
    protocol: '2026-07-28',
    startup: 'authentication-required',
    transport: 'streamable-http',
    url,
  } as const;
}
function buildConfig(options: {
  readonly diagnosticControlPath: string;
  readonly diagnosticPidFile: string;
  readonly legacyUrl: string;
  readonly modernUrl: string;
  readonly oauthUrl: string;
  readonly stdioPidFile: string;
}): string {
  return JSON.stringify({
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
          inheritedStdioEnvironmentArgument(),
          `--brainstrike-pid-file=${options.stdioPidFile}`,
        ],
        command: process.execPath,
        env: { BRAINSTRIKE_STDIO_FIXTURE: '1' },
        name: 'stdio',
        protocol: '2026-07-28',
        transport: 'stdio',
      },
      oauthServer(options.oauthUrl),
      {
        args: [
          stdioFixturePath(),
          inheritedStdioEnvironmentArgument(),
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
  });
}
async function openToolsSettings(page: Page): Promise<void> {
  await new HomePage(page).openSettings();
  await new SettingsPage(page).openCategory(/AI Tools/i, 'ai-tools');
  await page.getByRole('tab', { name: 'MCP Config' }).click();
  await expect(page.getByTestId('mcp-config-editor-panel')).toBeVisible({ timeout: 30_000 });
  // The editor renders only once the panel's first config read settles. Filling
  // before that races the load, which discards the typed config and the save
  // status, so this is the panel's real readiness signal.
  await expect(page.getByTestId('mcp-config-editor')).toBeVisible({ timeout: 30_000 });
}
async function configureThroughUi(page: Page, config: string): Promise<void> {
  await openToolsSettings(page);
  const editor = page.getByTestId('mcp-config-editor');
  await editor.fill(config);
  await page.getByTestId('mcp-config-save').click();
  await expect(page.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await page.getByRole('tab', { name: 'Tools' }).click();
}
function serverRow(page: Page, id: string) {
  return page.getByTestId(`mcp-server-row-${id}`);
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
        await access(path.join(controlDirectory, `ack-${id}`))
          .then(() => true)
          .catch(() => false),
      { timeout: 10_000 }
    )
    .toBe(true);
}
/**
 * A fixture process replays every `command-*` file from sequence zero, so a
 * relaunch would re-arm the exit and race the host's connect handshake: the
 * child can die before `initialize` settles, which leaves the restarted host
 * without its diagnostic-stdio connection. The restart phase expects that
 * server to serve normally, so retire the fault commands and disarm the
 * configuration while no fixture process is running.
 */
async function disarmDiagnosticFaults(
  controlDirectory: string,
  configurationPath: string
): Promise<void> {
  const entries = await readdir(controlDirectory);
  const faultCommands = entries.filter((entry) => /^command-\d{6}-(?:exit|stderr)$/u.test(entry));
  // Fail loudly rather than silently re-arming the relaunch race if the
  // fixture's command-file naming ever drifts from this pattern.
  expect(faultCommands.length).toBeGreaterThan(0);
  await Promise.all(faultCommands.map((entry) => rm(path.join(controlDirectory, entry))));
  // Read-modify-write: the fixture also reads `stderrText` and `exitCode` from
  // this document, so replacing it wholesale would silently drop them.
  const configuration: unknown = JSON.parse(await readFile(configurationPath, 'utf8'));
  if (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration)) {
    throw new Error(`Unexpected MCP lab fault control configuration at ${configurationPath}`);
  }
  await writeFile(configurationPath, JSON.stringify({ ...configuration, exitArmed: false }), {
    encoding: 'utf8',
    mode: 0o600,
  });
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
const LOOPBACK_BOUND_MESSAGE = 'MCP OAuth loopback callback listener bound';
const STALE_REGISTRATION_MESSAGE = 'Discarding stale MCP OAuth dynamic client registration';

/**
 * BST-1597: an ephemeral loopback port changed the registered redirect URI on
 * every launch, so each relaunch discarded the dynamic client registration and
 * surfaced a connection failure next to healthy-looking credentials. The port is
 * persisted per configured server, so the rebound listener must keep the same
 * port and never report a discard.
 */
async function readOAuthLoopbackBindings(userDataDir: string): Promise<Record<string, unknown>[]> {
  const records = await findLogRecords(userDataDir, 'brainstrike.log', LOOPBACK_BOUND_MESSAGE);
  return records.filter((record) => record['server'] === 'oauth');
}
async function connectOAuthThroughNativeBrowser(
  page: Page,
  cancellationFixture: PackagedFixture
): Promise<void> {
  await page.getByRole('button', { name: 'Connect oauth' }).click();
  await expect
    .poll(
      async () =>
        cancellationFixture.authorizationDelayObserved()
          ? 'authorization-observed'
          : ((await serverRow(page, 'oauth').textContent()) ?? 'missing-server-row'),
      { timeout: 30_000 }
    )
    .toBe('authorization-observed');
  await page.getByRole('button', { exact: true, name: 'Cancel oauth' }).click();
  await waitForServerState(page, 'oauth', /authentication-required|disconnected/i);
  await expect.poll(() => cancellationFixture.authorizationDelaySettled()).toBe(true);
  await page.getByRole('button', { exact: true, name: 'Connect oauth' }).click();
  await waitForServerState(page, 'oauth', /Connected/i);
  await expect(serverRow(page, 'oauth')).toContainText('2026-07-28');
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
async function readOwnedPid(pidFile: string, previous?: number): Promise<number> {
  let pid = 0;
  await expect
    .poll(
      async () => {
        const value = await readFile(pidFile, 'utf8').catch(() => '');
        pid = Number.parseInt(value.trim(), 10);
        return Number.isSafeInteger(pid) && pid > 0 && pid !== previous;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  return pid;
}
async function expectOwnedProcessGone(pid: number): Promise<void> {
  await expect.poll(() => processIsGone(pid), { timeout: 30_000 }).toBe(true);
}
async function readLifecycleDiagnostics(page: Page): Promise<{ hostPid: number; reset: unknown }> {
  return await page.evaluate(async () => {
    const bridge = (
      window as unknown as {
        desktopDiagnostics?: {
          getSnapshot: () => Promise<{ database: unknown; reset: unknown }>;
        };
      }
    ).desktopDiagnostics;
    if (!bridge) {
      throw new Error('Packaged desktop diagnostics bridge is unavailable');
    }
    const { database, reset } = await bridge.getSnapshot();
    const hostPid = Reflect.get(database ?? {}, 'hostPid');
    if (!(typeof hostPid === 'number' && Number.isSafeInteger(hostPid) && hostPid > 0)) {
      throw new Error('Packaged desktop database host PID is unavailable');
    }
    return { hostPid, reset };
  });
}
/**
 * BST-1592 — user-initiated `resources/read` reaching the packaged renderer.
 * Driven against the Brainstrike echo reference fixture (the `legacy` server),
 * not the pinned official everything profile.
 */
async function verifyResourceRead(page: Page): Promise<void> {
  const catalog = page.getByTestId('mcp-server-catalog-legacy');
  await expect(catalog).toBeVisible({ timeout: 60_000 });
  await catalog.getByRole('button', { name: `Read ${ECHO_RESOURCE_TITLE}` }).click();
  const content = page.getByTestId('mcp-catalog-content-legacy');
  await expect(content).toContainText(ECHO_RESOURCE_URI, { timeout: 30_000 });
  await expect(content).toContainText(ECHO_RESOURCE_MARKER);
}

/**
 * BST-1592 — user-initiated `prompts/get` reaching the packaged renderer
 * through the composer's "/" menu: select the MCP prompt, fill its argument in
 * the modal, and prove the server's own message text lands in the composer
 * DRAFT (never auto-sent).
 */
async function verifyComposerPromptSelection(page: Page): Promise<void> {
  const input = page.locator('#assistant-input');
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill('');
  await input.click();
  await input.pressSequentially(`/${ECHO_PROMPT_COMMAND_ID}`);
  const popover = page.getByTestId('assistant-slash-popover');
  await expect(popover).toBeVisible({ timeout: 30_000 });
  await popover.getByRole('option', { name: ECHO_PROMPT_MENU_LABEL }).click();
  const dialog = page.getByTestId('mcp-prompt-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  // Provenance: which configured server this prompt came from.
  await expect(dialog).toContainText('legacy');
  await dialog.getByLabel(ECHO_PROMPT_ARGUMENT).fill(ECHO_PROMPT_ARGUMENT_VALUE);
  await dialog.getByRole('button', { exact: true, name: 'Insert prompt' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(input).toHaveValue(ECHO_PROMPT_MESSAGE, { timeout: 30_000 });
}

/**
 * Every read here is BOUNDED. `.catch()` converts a rejection but never
 * shortens the wait that produced it, and this project sets no `actionTimeout`
 * (Playwright's default is 0 — no timeout), so an unmatched locator would
 * auto-wait the whole 420s test budget before its catch handler ever ran. An
 * explicit timeout is the only thing that makes these reads unstallable.
 */
const DIAGNOSTIC_READ_TIMEOUT_MS = 2000;
/**
 * Dump every observable boundary for a proof that took an unexpected branch:
 * the shim's decided turns (why the model said what it said), the assistant
 * transcript, and each tool card's own text. Read-only — it can never hang the
 * error path it exists to explain.
 */
async function describeAssistantState(
  page: Page,
  modelProvider: Awaited<ReturnType<typeof startModelProviderShim>>
): Promise<string> {
  // `.all()` resolves `nth(i)` lazily, so a transcript re-render between the
  // enumeration and the reads can leave an index unmatched; an unguarded
  // `innerText()` would then auto-wait the whole action timeout and reject,
  // stalling the very error path this function exists to keep fast.
  const cards = await page
    .getByTestId('tool-fallback')
    .all()
    .catch(() => []);
  const cardTexts = await Promise.all(
    cards.map((card) =>
      card
        .innerText({ timeout: DIAGNOSTIC_READ_TIMEOUT_MS })
        .catch((error: unknown) => `<unavailable: ${String(error)}>`)
    )
  );
  const region = await page
    .getByRole('region', { name: 'Assistant chat' })
    .innerText({ timeout: DIAGNOSTIC_READ_TIMEOUT_MS })
    .catch((error: unknown) => `<unavailable: ${String(error)}>`);
  return [
    `provider turns: ${JSON.stringify(modelProvider.transcript())}`,
    `tool cards (${cardTexts.length}): ${JSON.stringify(cardTexts)}`,
    `assistant region: ${region}`,
  ].join('\n');
}
async function executeAssistantTool(
  page: Page,
  modelProvider: Awaited<ReturnType<typeof startModelProviderShim>>
): Promise<void> {
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
  const approvalVisible = approval
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => 'approval' as const);
  const completedVisible = completed
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => 'completed' as const);
  // The racer that loses keeps waiting out its own budget and then rejects
  // (timeout, or "target closed" once the proof has moved on). Mark both as
  // handled so a decided race can never also surface an unhandled rejection as
  // a second, test-less error. `Promise.race` still settles on whichever
  // promise settles FIRST, so a genuine "neither appeared" still fails here.
  approvalVisible.catch(() => undefined);
  completedVisible.catch(() => undefined);
  const outcome = await Promise.race([approvalVisible, completedVisible]);
  if (outcome === 'completed') {
    throw new Error(
      `MCP tool bypassed approval or failed before suspension:\n${await describeAssistantState(page, modelProvider)}`
    );
  }
  await approval.getByRole('button', { name: /Approve/u }).click();
  await expect(completed).toBeVisible({ timeout: 90_000 });
  const activity = page
    .getByTestId('assistant-activity-group')
    .filter({ hasText: 'legacy.echo' })
    .last();
  const summary = activity.getByTestId('assistant-activity-summary');
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await summary.click();
  const toolCard = activity.getByTestId('tool-fallback').filter({ hasText: 'legacy.echo' }).last();
  await expect(toolCard.getByRole('img', { name: 'Completed' })).toBeVisible();
  await toolCard.getByRole('button', { exact: true, name: 'Expand details' }).click();
  await expect(toolCard).toContainText(ASSISTANT_TOOL_PAYLOAD);
}
async function executeElicitationTool(
  page: Page,
  modelProvider: Awaited<ReturnType<typeof startModelProviderShim>>
): Promise<void> {
  modelProvider.setScript({
    discoveryQuery: 'elicit confirm',
    finalText: 'Packaged MCP elicitation completed.',
    toolCall: {
      arguments: { text: ELICITATION_TOOL_PAYLOAD },
      name: 'oauth_elicit_confirm',
    },
  });
  const input = page.locator('#assistant-input');
  await input.fill('Run the packaged MCP elicitation proof.');
  await page.getByRole('button', { exact: true, name: 'Send' }).click();
  // The first proof's resolved approval notice (disabled Approve) stays in the
  // thread, so target this tool's own Approve button rather than `.last()`.
  const approve = page.getByRole('button', { exact: true, name: 'Approve oauth.elicit_confirm' });
  await approve.waitFor({ state: 'visible', timeout: 90_000 });
  await approve.click();
  const dialog = page.getByTestId('mcp-elicitation-dialog');
  await expect(dialog).toBeVisible({ timeout: 45_000 });
  // Provenance: the OAuth reference server identity plus the configured id.
  await expect(dialog).toContainText('brainstrike-sdk-v2-reference');
  await expect(dialog).toContainText('Configured server "oauth"');
  await expect(dialog).toContainText(
    `Confirm the reference elicitation for "${ELICITATION_TOOL_PAYLOAD}".`
  );
  await expect(dialog.getByRole('button', { name: /^Decline/u })).toBeFocused();
  await dialog.getByRole('checkbox', { name: 'Confirm' }).click();
  await dialog.getByRole('textbox', { name: 'Note' }).fill('approved from packaged e2e');
  await dialog.getByRole('button', { name: /^Accept/u }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText('Packaged MCP elicitation completed.').first()).toBeVisible({
    timeout: 90_000,
  });
  const activity = page
    .getByTestId('assistant-activity-group')
    .filter({ hasText: 'oauth.elicit_confirm' })
    .last();
  const summary = activity.getByTestId('assistant-activity-summary');
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await summary.click();
  const toolCard = activity
    .getByTestId('tool-fallback')
    .filter({ hasText: 'oauth.elicit_confirm' })
    .last();
  await expect(toolCard.getByRole('img', { name: 'Completed' })).toBeVisible();
  await toolCard.getByRole('button', { exact: true, name: 'Expand details' }).click();
  await expect(toolCard).toContainText(ELICITATION_TOOL_PAYLOAD);
}
function parseJsonLines(contents: string): Record<string, unknown>[] {
  const completeEnd = contents.lastIndexOf('\n');
  if (completeEnd < 0) {
    return [];
  }
  const values: unknown[] = contents
    .slice(0, completeEnd)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (values.some((value) => !(value && typeof value === 'object' && !Array.isArray(value)))) {
    throw new Error('Packaged MCP proof expected NDJSON objects');
  }
  return values as Record<string, unknown>[];
}
async function findLogRecords(
  userDataDir: string,
  fileName: string,
  message: string
): Promise<Record<string, unknown>[]> {
  let records: Record<string, unknown>[] = [];
  await expect
    .poll(
      async () => {
        const contents = await readFile(path.join(userDataDir, 'logs', fileName), 'utf8').catch(
          () => ''
        );
        records = parseJsonLines(contents).filter(
          (record) => record['message'] === message || record['msg'] === message
        );
        return records.length;
      },
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);
  return records;
}
async function attachFailureDiagnostics(
  testFailed: boolean,
  testInfo: TestInfo,
  userDataDir: string
): Promise<void> {
  if (!testFailed) {
    return;
  }
  const contents = await Promise.all(
    ['brainstrike-errors.ndjson', 'brainstrike.log'].map(
      async (entry) => await readFile(path.join(userDataDir, 'logs', entry), 'utf8').catch(() => '')
    )
  );
  await testInfo.attach('sanitized-mcp-logs', {
    body: contents.join('\n').slice(-256_000),
    contentType: 'application/x-ndjson',
  });
}
test('renderer reaches production MCP and lifecycle paths @packaged @destructive', async ({}, testInfo) => {
  test.setTimeout(420_000);
  const cleanup = new AsyncDisposableStack();
  let testFailed = false;
  let failure: unknown;
  let first: PackagedContext | undefined;
  let restarted: PackagedContext | undefined;
  const deferCleanup = (operation: () => Promise<void>): void => {
    cleanup.defer(async () => {
      try {
        await operation();
      } catch (error) {
        testFailed = true;
        throw error;
      }
    });
  };
  try {
    await access(packagedDesktopExecutablePath(), constants.X_OK);
    await access(stdioFixturePath(), constants.R_OK);
    const fixtureModule = await loadFixtures();
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bst-1577-packaged-user-data-'));
    deferCleanup(async () => await rm(userDataDir, { force: true, recursive: true }));
    const fixtureStateDir = await mkdtemp(path.join(os.tmpdir(), 'bst-1577-fixture-state-'));
    deferCleanup(async () => await rm(fixtureStateDir, { force: true, recursive: true }));
    cleanup.defer(async () => await attachFailureDiagnostics(testFailed, testInfo, userDataDir));
    const ownFixture = async (
      fixturePromise: Promise<PackagedFixture>,
      oauth = false
    ): Promise<PackagedFixture> => {
      const fixture = await fixturePromise;
      deferCleanup(async () => {
        const report = await fixture.close();
        expect(report).toMatchObject({
          clean: true,
          httpListenersClosed: 1,
          ...(oauth ? { oauthState: { clients: 0, codes: 0, states: 0, tokens: 0 } } : {}),
        });
      });
      return fixture;
    };
    const modern = await ownFixture(fixtureModule.startPackagedCoreFixture('modern-reference'));
    const legacy = await ownFixture(fixtureModule.startPackagedCoreFixture('legacy-reference'));
    const oauth = await ownFixture(
      fixtureModule.startPackagedCoreFixture('oauth-reference', { authorizationDelayMs: 1000 }),
      true
    );
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
      discoveryQuery: 'legacy echo',
      finalText: 'Packaged MCP tool completed.',
      toolCall: {
        arguments: { text: ASSISTANT_TOOL_PAYLOAD },
        name: 'legacy_echo',
      },
    });
    deferCleanup(modelProvider.close);
    const environment = {
      BRAINSTRIKE_OPENROUTER_API_KEY: 'packaged-e2e-provider-key',
      OPENROUTER_BASE_URL: modelProvider.baseUrl,
      ...(await configureLinuxOAuthBrowser(fixtureStateDir)),
    };
    first = await launchPackagedDesktop({ environment, userDataDir });
    deferCleanup(async () => {
      if (first) {
        await closePackagedDesktop(first);
      }
    });
    expect(await first.app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await configureThroughUi(
      first.window,
      buildConfig({
        diagnosticControlPath,
        diagnosticPidFile,
        legacyUrl: legacy.manifest.url,
        modernUrl: modern.manifest.url,
        oauthUrl: oauth.manifest.url,
        stdioPidFile,
      })
    );
    for (const [server, revision] of [
      ['modern', '2026-07-28'],
      ['legacy', '2025-11-25'],
    ] as const) {
      await waitForServerState(first.window, server, /Connected/i);
      await expect(serverRow(first.window, server)).toContainText(revision);
    }
    await waitForServerState(first.window, 'stdio', /Connected/i);
    await verifyResourceRead(first.window);
    const firstStdioPid = await readOwnedPid(stdioPidFile);
    await verifyDiagnosticFailure(first.window, diagnosticControlDirectory);
    await expectOwnedProcessGone(await readOwnedPid(diagnosticPidFile));
    await connectOAuthThroughNativeBrowser(first.window, oauth);
    await new SettingsPage(first.window).openCategory(/Permissions/i, 'permissions');
    const permission = first.window.getByRole('combobox', { name: 'MCP permission' });
    await permission.selectOption('ask');
    await expect(permission).toHaveValue('ask');
    await executeAssistantTool(first.window, modelProvider);
    await executeElicitationTool(first.window, modelProvider);
    await verifyComposerPromptSelection(first.window);
    await closePackagedDesktop(first);
    first = undefined;
    await expectOwnedProcessGone(firstStdioPid);
    const durable = (
      await findLogRecords(
        userDataDir,
        'brainstrike-errors.ndjson',
        'MCP stdio failure diagnostics'
      )
    ).at(-1);
    expect(durable).toMatchObject({
      context: {
        diagnostics: [
          { message: 'mcp-lab-stdio-ready', stream: 'stderr', truncated: false },
          { message: 'mcp-lab-stdio-ready-second-chunk', stream: 'stderr', truncated: false },
          {
            message:
              'Authorization: [redacted-secret:bearer-token] https://auth.invalid/callback?[redacted-query]',
            stream: 'stderr',
            truncated: false,
          },
        ],
        generation: expect.any(Number),
        omittedDiagnostics: 0,
        server: 'diagnostic-stdio',
      },
      message: 'MCP stdio failure diagnostics',
      severity: 'warn',
      source: 'electron-main',
    });
    const diagnosticGeneration = Reflect.get(
      Reflect.get(durable ?? {}, 'context') ?? {},
      'generation'
    );
    expect(Number.isSafeInteger(diagnosticGeneration) && Number(diagnosticGeneration) > 0).toBe(
      true
    );
    expect(JSON.stringify(durable)).not.toContain('bst-1577-secret');
    const firstShutdown = (
      await findLogRecords(userDataDir, 'brainstrike.log', 'MCP runtime shutdown cleanup completed')
    ).at(-1);
    const firstCloseReport = Reflect.get(firstShutdown ?? {}, 'hostCloseReport') as CloseReport;
    expect(firstCloseReport).toMatchObject({
      failures: [],
      loopbackPortsClosed: 1,
      probesClosed: 0,
      subscriptionsClosed: 1,
    });
    expect(firstCloseReport['childProcessesClosed']).toBeGreaterThanOrEqual(3);
    expect(firstCloseReport['clientsClosed']).toBeGreaterThanOrEqual(6);
    expect(firstCloseReport['callbacksClosed']).toBe(Number(firstCloseReport['clientsClosed']) + 1);
    expect(firstShutdown).toMatchObject({ legacyClientsClosed: true });
    const bindingsBeforeRestart = await readOAuthLoopbackBindings(userDataDir);
    const firstLaunchLoopbackPort = bindingsBeforeRestart.at(-1)?.['port'];
    expect(typeof firstLaunchLoopbackPort).toBe('number');
    await disarmDiagnosticFaults(diagnosticControlDirectory, diagnosticControlPath);
    restarted = await launchPackagedDesktop({ environment, userDataDir });
    deferCleanup(async () => {
      if (restarted) {
        await closePackagedDesktop(restarted);
      }
    });
    await openToolsSettings(restarted.window);
    await restarted.window.getByRole('tab', { name: 'Tools' }).click();
    await waitForServerState(restarted.window, 'modern', /Connected/i);
    await waitForServerState(restarted.window, 'stdio', /Connected/i);
    const restartedStdioPid = await readOwnedPid(stdioPidFile, firstStdioPid);
    const beforeResetDiagnostics = await readLifecycleDiagnostics(restarted.window);
    // A persisted grant reconnects during startup discovery, without another
    // Connect action. Waiting for authentication-required encoded the old bug.
    await waitForServerState(restarted.window, 'oauth', /Connected/i);
    await expect(serverRow(restarted.window, 'oauth')).toContainText('OAuth credentials stored');
    await expect(
      restarted.window.getByRole('button', { exact: true, name: 'Connect oauth' })
    ).toHaveCount(0);
    const restartedBindings = await readOAuthLoopbackBindings(userDataDir);
    expect(restartedBindings.length).toBeGreaterThan(bindingsBeforeRestart.length);
    // The log file is cumulative, so only the records this launch appended say
    // anything about rebinding the persisted port.
    const bindingsAfterRestart = restartedBindings.slice(bindingsBeforeRestart.length);
    expect(bindingsAfterRestart.map((record) => record['port'])).toEqual(
      bindingsAfterRestart.map(() => firstLaunchLoopbackPort)
    );
    expect(bindingsAfterRestart.at(-1)).toMatchObject({ reusedPersistedPort: true });
    expect(
      parseJsonLines(
        await readFile(path.join(userDataDir, 'logs', 'brainstrike.log'), 'utf8')
      ).filter(
        (record) =>
          record['msg'] === STALE_REGISTRATION_MESSAGE ||
          record['message'] === STALE_REGISTRATION_MESSAGE
      )
    ).toEqual([]);
    await new HomePage(restarted.window).openSettings();
    await new SettingsPage(restarted.window).openCategory(/Factory Reset/i, 'factory-reset');
    await restarted.window.evaluate(() => {
      window.confirm = () => true;
    });
    const replacementLoaded = restarted.window.waitForEvent('domcontentloaded', {
      timeout: 60_000,
    });
    await restarted.window.getByTestId('factory-reset-button').click();
    await replacementLoaded;
    await openToolsSettings(restarted.window);
    await restarted.window.getByRole('tab', { name: 'Tools' }).click();
    await expect(restarted.window.getByTestId('mcp-server-status-empty')).toHaveText(
      'No MCP servers configured.'
    );
    await expectOwnedProcessGone(restartedStdioPid);
    const resetEvidence = (
      await findLogRecords(userDataDir, 'brainstrike.log', 'MCP runtime reset cleanup completed')
    ).at(-1);
    // Counts include the oauth server this phase reconnected: one more client,
    // its provider's extra callback, and the loopback port that provider owns.
    expect(resetEvidence).toMatchObject({
      hostCloseReport: {
        callbacksClosed: 6,
        childProcessesClosed: 2,
        clientsClosed: 5,
        failures: [],
        loopbackPortsClosed: 1,
        probesClosed: 0,
        subscriptionsClosed: 0,
      },
      legacyClientsClosed: true,
      snapshot: { servers: [] },
    });
    const resetCloseReport = Reflect.get(resetEvidence ?? {}, 'hostCloseReport') as CloseReport;
    expect(resetCloseReport['requestsSettled']).toBeGreaterThanOrEqual(3);
    const afterResetDiagnostics = await readLifecycleDiagnostics(restarted.window);
    expect(afterResetDiagnostics.reset).toMatchObject({
      lastCompletedAt: expect.any(String),
      lastError: null,
      status: 'completed',
    });
    expect(afterResetDiagnostics.hostPid).not.toBe(beforeResetDiagnostics.hostPid);
    await configureThroughUi(
      restarted.window,
      JSON.stringify({ servers: [oauthServer(oauth.manifest.url)] })
    );
    await waitForServerState(restarted.window, 'oauth', /authentication-required/i);
    await expect(serverRow(restarted.window, 'oauth')).toContainText(
      'OAuth credentials not stored'
    );
  } catch (error) {
    testFailed = true;
    failure = error;
  }
  try {
    await cleanup.disposeAsync();
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError([failure, error], 'Packaged MCP test and cleanup failed');
  }
  if (failure !== undefined) {
    throw failure;
  }
});
