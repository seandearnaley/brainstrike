import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as playwrightEnvironment from '@brainstrike/config/playwright-environment';
import { getTestDirectoryStructure } from '@brainstrike/file-system';
import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';
import agentDevToolsDefaults from '../../agent-devtools-defaults.json' with { type: 'json' };
import {
  closeModelProviderShimWithProcess,
  type ModelProviderShim,
  resolveProviderEgressEnvironment,
  startModelProviderShim,
} from './model-provider-shim.ts';

declare const process: NodeJS.Process;
const require = createRequire(import.meta.url);

const { getCILaunchArgs } = playwrightEnvironment;
const e2eUserDataDirEnv = 'BRAINSTRIKE_E2E_USER_DATA_DIR';
const dbRootPathEnv = 'BRAINSTRIKE_DB_ROOT_PATH';
const e2eRealRootPathEnv = 'BRAINSTRIKE_E2E_REAL_ROOT_PATH';

export interface ElectronAppContext {
  app: ElectronApplication;
  window: Page;
}

interface LaunchElectronAppOptions {
  readonly disableExternalLocalRuntimeProbes?: boolean;
  /** Extra environment for this launch, applied BEFORE the harness's own variables so it cannot override them. */
  readonly env?: Readonly<Record<string, string>>;
  readonly launchMode?: 'built' | 'dev-server' | 'test-built';
  /**
   * The provider egress boundary for this launch. The harness passes its own so
   * scripts survive restarts; any other launch owns one until its app exits.
   */
  readonly modelProvider?: ModelProviderShim;
  readonly onAppAcquired?: (app: ElectronApplication) => void;
  readonly userDataDir?: string;
  /**
   * A real folder the test-mode folder picker mounts when neither the process
   * environment nor the spec's env names one (BRAINSTRIKE_E2E_REAL_ROOT_PATH).
   * Main validates a host thread's bound root on disk, so a mounted root must exist.
   */
  readonly workspaceRoot?: string;
}

interface ElectronOutputBuffer {
  stderr: string[];
  stdout: string[];
}

const intentionallyClosingApps = new WeakSet<ElectronApplication>();
const electronOutputBuffers = new WeakMap<ElectronApplication, ElectronOutputBuffer>();
const isVerboseE2eLoggingEnabled = process.env['BRAINSTRIKE_E2E_VERBOSE'] === '1';
const electronAppCloseTimeoutMs = 10_000;
const ignoredElectronOutputPatterns = [
  'Electron Security Warning (Insecure Content-Security-Policy)',
  'This renderer process has either no Content Security',
  'Policy set or a policy with "unsafe-eval" enabled.',
  'For more information and help, consult',
  'https://electronjs.org/docs/tutorial/security.',
  'This warning will not show up',
  'once the app is packaged.',
  'this app to unnecessary security risks.',
  "Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.",
  '(Use `Electron --trace-warnings ...` to show where the warning was created)',
  '🔸 Setting up file system API mocks...',
  '🔸 Mocked requestDirectoryAccess called',
  '🔸 Mocked exists called with path:',
  '🔸 Mocked readDirectory called with path:',
  '🔸 Mocked readFile called with path:',
  '🔸 Mocked writeFile called with path:',
  '🔸 Mocked watchDirectory called with path:',
  '🔸 Mocked unwatch called',
  '🔸 Mocked showDirectoryPicker called',
  '🔸 Mocked showOpenDialog called with options:',
  '🔸 Mocked showSaveDialog called with options:',
  '🔸 Mocked showMessageBox called with options:',
  '🔸 Mocked showErrorBox called:',
  '🔸 Mocked showCertificateTrustDialog called with args:',
  'Failed to create WebGPU Context Provider',
  '[EmbeddingWorker] Initializing deferred local embedding model for claimed work',
  '[EmbeddingWorker] Stopping embedding worker after fatal local model error',
  '[EmbeddingHostRuntime] Embedding host worker stopped after fatal local model error',
  '[EmbeddingWorker] handleBatchFailure: Job(s) failed',
  '"msg":"Lazy-loading database (triggered by IPC usage)"',
  '"msg":"Created database directory:',
  '"msg":"pgvector extension loaded successfully (ESM)"',
  '"msg":"pglite live query extension loaded successfully (ESM)"',
  '"msg":"Database initialized with pgvector extension at:"',
  '"msg":"Database initialized successfully at:',
  '"msg":"Database connection closed"',
  '"msg":"DB host process started"',
  '"msg":"DB host init completed"',
  '"msg":"Window startup: dom-ready"',
  '"msg":"Window startup: did-finish-load"',
  '"msg":"Window startup: browser-window-created"',
  '"msg":"Window startup: loading-renderer"',
  '"msg":"Window startup: renderer-load-invocation-returned"',
  '"msg":"Loading renderer"',
  '"msg":"Loading built renderer file"',
  '"reloadReason":"playwright-reset-renderer"',
  '"reloadReason":"assistant-mock-init-script"',
  '"reloadReason":"embedding-worker-large-backfill-fixture"',
  '"reloadReason":"embedding-worker-host-processing-fixture"',
  '"reloadReason":"embedding-worker-import-backfill-flow"',
  '"reloadReason":"startup-restore-regression"',
  '"msg":"Registering MCP IPC handlers"',
  '"msg":"discoverMcpToolsOnStartup called"',
  '"msg":"MCP config missing, cleared tool registry"',
  '"msg":"Loaded MCP config for discovery"',
  '"msg":"Registering tools IPC handlers"',
  '"msg":"App ready, starting initialization..."',
  '"msg":"Setting up IPC handlers that require app readiness..."',
  '"msg":"Ready-dependent IPC handlers registered successfully"',
  '"msg":"Desktop file logging configuration resolved"',
  '"msg":"Desktop file logging is not active"',
  '"msg":"Security setup complete"',
  '"msg":"CSP configured"',
  '"msg":"Assistant server started at http://',
  '"msg":"Creating main window..."',
  '"msg":"Main window created successfully"',
  '"msg":"main-thread watchdog started"',
  '"msg":"main-process-health"',
  '"msg":"Skipping maximize in desktop E2E mode because Electron shows hidden windows when maximizing"',
  '"msg":"Window startup: did-start-loading"',
  '"msg":"Window startup: renderer-loaded"',
  '"msg":"powerSaveBlocker started for active embedding host work"',
  '"msg":"powerSaveBlocker stopped for idle embedding host"',
  '"msg":"Failed to resubscribe live query after pause release"',
  '"msg":"Using environment API key for provider"',
  '"msg":"mastra runtime initialized"',
  '"msg":"mastra stream started"',
  '"msg":"mastra stream finished"',
  '"msg":"registry cleared"',
  '"msg":"discovered suspended approvals"',
  '"msg":"brainstrike-asset protocol registered"',
  '"msg":"brainstrike-canvas protocol registered"',
  '"msg":"Browser pane session partition configured"',
  '"msg":"Browser pane host created"',
  '"msg":"Startup thread-run reap completed"',
  '"msg":"Workspace snapshot orphan sweep completed"',
  '"msg":"Workspace snapshot startup GC completed"',
  '"msg":"Dimension index maintenance capability probe completed"',
  '"msg":"Started parcel watcher"',
  '[ERROR:dbus/bus.cc:406] Failed to connect to the bus:',
  '[ERROR:dbus/object_proxy.cc:573] Failed to call method: org.freedesktop.DBus.NameHasOwner:',
  'Debugger ending on ws://',
  'For help, see: https://nodejs.org/en/docs/inspector',
  'SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.',
] as const;

function shouldIgnoreElectronOutput(output: string): boolean {
  if (isVerboseE2eLoggingEnabled) {
    return false;
  }

  return ignoredElectronOutputPatterns.some((pattern) => output.includes(pattern));
}

function printElectronOutput(
  prefix: string,
  output: string,
  printer: (...args: unknown[]) => void
): void {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    if (shouldIgnoreElectronOutput(line)) {
      continue;
    }

    printer(`${prefix}${line}`);
  }
}

function appendElectronOutput(buffer: string[], output: string): void {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  buffer.push(...lines);
  if (buffer.length > 500) {
    buffer.splice(0, buffer.length - 500);
  }
}

function verboseLog(...args: unknown[]): void {
  if (!isVerboseE2eLoggingEnabled) {
    return;
  }
  console.log(...args);
}

function verboseError(...args: unknown[]): void {
  if (!isVerboseE2eLoggingEnabled) {
    return;
  }
  console.error(...args);
}

// Single launch attempt - extracted for reduced complexity
async function attemptElectronLaunch(
  launchOptions: Parameters<typeof electron.launch>[0],
  firstWindowTimeout: number,
  onAppAcquired?: (app: ElectronApplication) => void
): Promise<ElectronAppContext> {
  const app = await startElectron(launchOptions, onAppAcquired);

  try {
    verboseLog('⏳ Waiting for first window...');
    const window = await app.firstWindow({ timeout: firstWindowTimeout });
    await window.waitForLoadState('domcontentloaded');
    await setupDialogMocking(app);
    return { app, window };
  } catch (error) {
    if (!onAppAcquired) {
      try {
        await closeElectronApp({ app });
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'Electron launch and cleanup failed');
      }
    }
    throw error;
  }
}

// Log environment diagnostics for debugging CI issues
function logEnvironmentDiagnostics(userDataDir?: string): void {
  verboseLog('[DEBUG][HYP-A] NODE_OPTIONS:', process.env['NODE_OPTIONS'] ?? '<not set>');
  verboseLog('[DEBUG][HYP-A] NODE_DEBUG:', process.env['NODE_DEBUG'] ?? '<not set>');
  verboseLog(
    '[DEBUG][HYP-A] ELECTRON_ENABLE_STACK_DUMPING:',
    process.env['ELECTRON_ENABLE_STACK_DUMPING'] ?? '<not set>'
  );
  verboseLog('[DEBUG][HYP-C] DISPLAY:', process.env['DISPLAY'] ?? '<not set>');
  verboseLog('[DEBUG][HYP-C] WAYLAND_DISPLAY:', process.env['WAYLAND_DISPLAY'] ?? '<not set>');
  verboseLog('[DEBUG][HYP-C] XDG_SESSION_TYPE:', process.env['XDG_SESSION_TYPE'] ?? '<not set>');
  if (userDataDir) {
    verboseLog(`📂 Using custom user data dir: ${userDataDir}`);
  }
}

export async function launchElectronApp(
  _debugPort?: number,
  userDataDir?: string,
  options: Pick<
    LaunchElectronAppOptions,
    | 'disableExternalLocalRuntimeProbes'
    | 'env'
    | 'modelProvider'
    | 'workspaceRoot'
    | 'onAppAcquired'
  > = {}
): Promise<ElectronAppContext> {
  return await launchElectronAppWithOptions({
    ...options,
    launchMode: 'test-built',
    userDataDir,
  });
}

export async function launchElectronAppWithOptions(
  options: LaunchElectronAppOptions = {}
): Promise<ElectronAppContext> {
  // Every launch has a provider egress boundary (BST-1931). A caller's boundary
  // survives restarts; otherwise this launch owns one until its app exits.
  if (options.modelProvider) {
    return await launchElectronAppWithBoundary(options, options.modelProvider);
  }
  const boundary = await startModelProviderShim();
  try {
    const context = await launchElectronAppWithBoundary(options, boundary);
    closeModelProviderShimWithProcess(boundary, context.app.process());
    return context;
  } catch (error) {
    await boundary.close();
    throw error;
  }
}

async function launchElectronAppWithBoundary(
  options: LaunchElectronAppOptions,
  modelProvider: ModelProviderShim
): Promise<ElectronAppContext> {
  const electronPath = require('electron');
  const mainPath = path.resolve(import.meta.dirname, '..', '..', 'dist', 'main.js');
  if (!fs.existsSync(mainPath)) {
    throw new Error(`Desktop E2E main entry is missing at ${mainPath}`);
  }

  const launchMode = options.launchMode ?? 'test-built';
  const userDataDir = options.userDataDir;
  if (!userDataDir) {
    throw new Error('Desktop E2E launches must provide an isolated userDataDir.');
  }
  const providerEgressEnv = resolveProviderEgressEnvironment(modelProvider, [
    options.env ?? {},
    process.env,
  ]);

  // Launch retries hide startup races and inflate failing PR/runtime cost. The
  // harness must fail once with the launch evidence that caused the failure.
  const maxAttempts = 1;
  const firstWindowTimeout = process.env['CI'] ? 30_000 : 60_000;
  const launchTimeoutMs = process.env['CI'] ? 150_000 : 60_000;

  verboseLog('🚀 Launching Electron app...');
  logEnvironmentDiagnostics(userDataDir);
  verboseLog('Electron path:', electronPath);
  verboseLog('Main path:', mainPath);
  verboseLog('Launch timeout (ms):', launchTimeoutMs);

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    verboseLog(`🔄 Launch attempt ${attempt}/${maxAttempts}`);

    const launchOptions = createLaunchOptions(
      electronPath,
      mainPath,
      undefined,
      userDataDir,
      launchTimeoutMs,
      launchMode,
      options.disableExternalLocalRuntimeProbes ?? false,
      options.env ?? {},
      providerEgressEnv,
      options.workspaceRoot
    );

    try {
      return await attemptElectronLaunch(launchOptions, firstWindowTimeout, options.onAppAcquired);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`❌ Launch attempt ${attempt} failed:`, lastError.message);

      if (attempt < maxAttempts) {
        const delay = attempt * 2000;
        verboseLog(`⏸️ Waiting ${delay}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(
    `Failed to launch Electron after ${maxAttempts} attempts: ${lastError?.message}`,
    { cause: lastError }
  );
}

export async function getBufferedElectronOutput(
  app: ElectronApplication
): Promise<ElectronOutputBuffer> {
  const buffer = electronOutputBuffers.get(app);
  return {
    stderr: [...(buffer?.stderr ?? [])],
    stdout: [...(buffer?.stdout ?? [])],
  };
}

// NOTE: killSpecificElectronProcess was removed - we no longer use explicit debug ports
// Playwright manages CDP connections automatically, preventing debugger disconnect hangs.

function createLaunchOptions(
  _electronPath: string,
  mainPath: string,
  _debugPort: number | undefined,
  userDataDir: string | undefined,
  launchTimeoutMs: number | undefined,
  launchMode: 'built' | 'dev-server' | 'test-built',
  disableExternalLocalRuntimeProbes: boolean,
  extraEnv: Readonly<Record<string, string>>,
  /** Provider egress boundary values; applied over every other source (BST-1931). */
  providerEgressEnv: Readonly<Record<string, string>>,
  /** The default mounted folder; the process env and the spec's env both override it. */
  workspaceRoot: string | undefined
): Parameters<typeof electron.launch>[0] {
  const { ELECTRON_RUN_AS_NODE: _ignoredElectronRunAsNode, ...baseEnv } = process.env;
  const ciArgs = getCILaunchArgs();
  const shouldDisableGpuForE2e =
    process.env['CI'] === 'true' && process.env['BRAINSTRIKE_E2E_ALLOW_GPU'] !== '1';
  const shouldSerializePGliteInit =
    process.env['CI'] === 'true' && process.env['GITHUB_ACTIONS'] === 'true';
  const baseArgs = [
    mainPath,
    '--test-mode',
    '--js-flags=--expose-gc',
    // Without this flag Chromium quantizes performance.memory.usedJSHeapSize
    // AND caches it for 20 minutes, so within a single test every heap read
    // returns the identical value and the memory ceilings can never bind.
    '--enable-precise-memory-info',
    `--brainstrike-desktop-launch-mode=${launchMode}`,
    '--disable-dialogs',
    // NOTE: Do NOT specify --remote-debugging-port here.
    // Playwright manages its own CDP connection via electron.launch().
    // Specifying an explicit port can cause "Waiting for debugger to disconnect" hangs.
    // Explicitly set user data dir to avoid collisions in shared environments
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    ...(process.env['BRAINSTRIKE_E2E_AGENT_DEVTOOLS'] === '1'
      ? [
          '--brainstrike-agent-devtools',
          `--brainstrike-agent-devtools-port=${agentDevToolsDefaults.defaultPort}`,
        ]
      : []),
    // Disable GPU features to prevent crashes/hangs in CI.
    // Allow GPU in specific tests (e.g., WebGPU memory diagnostics) via env var.
    ...(shouldDisableGpuForE2e
      ? ['--disable-gpu', '--disable-gpu-sandbox', '--disable-software-rasterizer']
      : []),
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Additional flags to prevent debugger/inspector issues
    '--disable-extensions',
    // Allow backgrounding in specific crash-reproduction tests to test the
    // production code path where Chromium throttles backgrounded renderers.
    ...(process.env['BRAINSTRIKE_E2E_ALLOW_BACKGROUNDING'] === '1'
      ? []
      : ['--disable-background-timer-throttling', '--disable-renderer-backgrounding']),
  ];

  // #region Linux CI DISPLAY resolution diagnostics
  const currentDisplay = process.env['DISPLAY'];
  const isLinuxCI = process.platform === 'linux' && process.env['CI'];
  const needsDisplayFallback = isLinuxCI && !currentDisplay;
  verboseLog('[DEBUG][HYP-C] DISPLAY resolution:', {
    currentDisplay: currentDisplay ?? '<not set>',
    isCI: Boolean(process.env['CI']),
    needsDisplayFallback,
    platform: process.platform,
    willUseFallback: needsDisplayFallback ? ':99' : 'N/A',
  });
  // #endregion

  const options: Parameters<typeof electron.launch>[0] = {
    args: [...baseArgs, ...ciArgs],
    env: {
      ...(workspaceRoot ? { [e2eRealRootPathEnv]: workspaceRoot } : {}),
      ...baseEnv,
      // Before every harness-owned variable below: a spec's env can add, never override them.
      ...extraEnv,
      // Provider base URLs, MASTRA_OFFLINE: the egress boundary owns these keys.
      ...providerEgressEnv,
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      ELECTRON_DISABLE_SANDBOX: '1',
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      ELECTRON_ENABLE_LOGGING: 'true',
      ...(userDataDir
        ? {
            [e2eUserDataDirEnv]: userDataDir,
            [dbRootPathEnv]: userDataDir,
          }
        : {}),
      // Force console logging and disable file logging to avoid contention/permissions issues
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
      // BST-1864: `windowFocus` reports the NATIVE window's focus, and this harness
      // window is `focusable: false` and never shown, so it is never focused —
      // while Playwright forces the renderer's `document.hasFocus()` true. Left on,
      // every spec would run with an unfocused app (indexer polling, the unseen
      // badge); off, each keeps the focused app it has always run with. An explicit
      // value wins, `''` included, so a spec that tests the bridge opts in with `''`.
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      BRAINSTRIKE_E2E_DISABLE_PRELOAD_BRIDGES:
        baseEnv['BRAINSTRIKE_E2E_DISABLE_PRELOAD_BRIDGES'] ?? 'windowFocus',
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      BRAINSTRIKE_OPENAI_API_KEY: 'test-api-key-for-e2e-tests',
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      ELECTRON_IS_E2E_TEST: 'true',
      ...(shouldSerializePGliteInit
        ? {
            // Linux GitHub Actions runs multiple isolated Electron apps in one
            // shard. Serialize the PGlite open/extension-registration phase so
            // workers stay parallel without racing the shared WASM bootstrap.
            // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
            BRAINSTRIKE_SERIALIZE_PGLITE_INIT: '1',
          }
        : {}),
      ...(disableExternalLocalRuntimeProbes
        ? {
            // Regression E2E should not contact developer-local Ollama/LM Studio
            // daemons unless the test explicitly validates that bridge.
            // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
            BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES: '1',
          }
        : {}),
      ...(launchMode === 'dev-server'
        ? {
            // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
            CI: 'false',
            // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
            NODE_ENV: 'test',
          }
        : {}),
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      ELECTRON_ENABLE_STACK_DUMPING: 'false',
      // Prevent V8 inspector issues that cause "Waiting for debugger to disconnect" hangs
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      NODE_OPTIONS: '', // Clear any inherited NODE_OPTIONS that might enable --inspect
      ...(shouldDisableGpuForE2e
        ? {
            // Disable GPU acceleration in CI where Chromium GPU startup is unstable.
            // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
            ELECTRON_DISABLE_GPU: '1',
          }
        : {}),
      // Ensure DISPLAY in Linux CI if not provided by runner
      ...(needsDisplayFallback
        ? // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
          { DISPLAY: ':99' }
        : {}),
    },
    // Let Playwright manage the CDP connection - don't override
    timeout: launchTimeoutMs ?? 150_000, // Increased to 150s for CI stability
  };
  return options;
}

// #region Linux CI Electron binary preflight
function runPreflightElectronCheck(displayEnv: string | undefined): void {
  if (process.platform !== 'linux' || !process.env['CI']) {
    return;
  }

  const electronBinaryPath = require('electron');
  const fs = require('node:fs');
  const { execSync } = require('node:child_process');

  const effectiveDisplay = displayEnv ?? process.env['DISPLAY'];
  verboseLog('[DEBUG][HYP-F] Checking Electron binary...');
  verboseLog('[DEBUG][HYP-F] Binary path:', electronBinaryPath);
  verboseLog('[DEBUG][HYP-F] Effective DISPLAY:', effectiveDisplay);

  // #region X display accessibility diagnostics
  try {
    verboseLog('[DEBUG][HYP-I] Checking if X display is accessible...');
    const xdpyOutput = execSync(`xdpyinfo -display "${effectiveDisplay}" 2>&1 | head -5`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    verboseLog('[DEBUG][HYP-I] X display accessible:', xdpyOutput.trim().split('\n')[0]);
  } catch (xdpyErr) {
    verboseError('[DEBUG][HYP-I] X DISPLAY NOT ACCESSIBLE:', (xdpyErr as Error).message);
    // Try to list what Xvfb servers are running
    try {
      const psOutput = execSync('ps aux | grep -i xvfb | grep -v grep', {
        encoding: 'utf8',
        timeout: 5000,
      });
      verboseLog('[DEBUG][HYP-I] Running Xvfb processes:', psOutput.trim());
    } catch {
      verboseLog('[DEBUG][HYP-I] No Xvfb processes found');
    }
  }
  // #endregion

  try {
    const stats = fs.statSync(electronBinaryPath);
    verboseLog('[DEBUG][HYP-F] Binary exists, size:', stats.size);
    verboseLog('[DEBUG][HYP-F] Binary mode:', stats.mode.toString(8));
  } catch (statErr) {
    verboseError('[DEBUG][HYP-F] Cannot stat binary:', statErr);
  }

  // Check for missing libraries using ldd
  try {
    const lddOutput = execSync(`ldd "${electronBinaryPath}" 2>&1 | grep -i "not found"`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (lddOutput.trim()) {
      verboseError('[DEBUG][HYP-F] MISSING LIBRARIES DETECTED:');
      verboseError(lddOutput);
    }
  } catch (lddErr) {
    // grep returns exit code 1 when no matches - that's good (no missing libs)
    if ((lddErr as { status?: number }).status === 1) {
      verboseLog('[DEBUG][HYP-F] No missing libraries detected');
    } else {
      verboseLog('[DEBUG][HYP-F] ldd check inconclusive:', (lddErr as Error).message);
    }
  }

  // Try to run electron --version to verify it can execute
  try {
    const versionOutput = execSync(`"${electronBinaryPath}" --version 2>&1`, {
      encoding: 'utf8',
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      env: { ...process.env, DISPLAY: displayEnv ?? process.env['DISPLAY'] },
      timeout: 10_000,
    });
    verboseLog('[DEBUG][HYP-F] Electron version check:', versionOutput.trim());
  } catch (versionErr) {
    verboseError('[DEBUG][HYP-F] Electron version check FAILED:', (versionErr as Error).message);
  }
}
// #endregion

async function startElectron(
  launchOptions: Parameters<typeof electron.launch>[0],
  onAppAcquired?: (app: ElectronApplication) => void
) {
  // #region Electron pre-launch diagnostics
  verboseLog('[DEBUG][HYP-D] Pre-launch diagnostics:');
  verboseLog('[DEBUG][HYP-D] Platform:', process.platform);
  verboseLog('[DEBUG][HYP-D] Arch:', process.arch);
  verboseLog('[DEBUG][HYP-D] CI:', process.env['CI'] ?? '<not set>');
  verboseLog('[DEBUG][HYP-D] GITHUB_ACTIONS:', process.env['GITHUB_ACTIONS'] ?? '<not set>');
  verboseLog('[DEBUG][HYP-D] Launch args:', JSON.stringify(launchOptions?.args ?? []));
  verboseLog('[DEBUG][HYP-D] Launch env keys:', Object.keys(launchOptions?.env ?? {}).join(', '));
  // #endregion

  // Run pre-flight check for Linux CI environments
  runPreflightElectronCheck(launchOptions?.env?.['DISPLAY']);

  const launchStartTime = Date.now();
  try {
    verboseLog('[DEBUG] Calling electron.launch() at', new Date().toISOString());
    const app = await electron.launch(launchOptions);
    onAppAcquired?.(app);
    verboseLog('[DEBUG] electron.launch() returned after', Date.now() - launchStartTime, 'ms');

    // Pipe stdout and stderr for debugging CI crashes
    const electronProcess = app.process();
    const pid = electronProcess.pid;
    const outputBuffer: ElectronOutputBuffer = { stderr: [], stdout: [] };
    electronOutputBuffers.set(app, outputBuffer);
    verboseLog(`🔧 Attaching process listeners for stdout/stderr (PID: ${pid})`);

    // #region Electron stdio availability diagnostics
    verboseLog(
      '[DEBUG][HYP-G] stdout pipe:',
      electronProcess.stdout ? 'available' : 'NOT AVAILABLE'
    );
    verboseLog(
      '[DEBUG][HYP-G] stderr pipe:',
      electronProcess.stderr ? 'available' : 'NOT AVAILABLE'
    );
    verboseLog('[DEBUG][HYP-G] stdin pipe:', electronProcess.stdin ? 'available' : 'NOT AVAILABLE');
    // #endregion

    let stdoutReceived = false;
    let stderrReceived = false;

    // #region Electron process output capture
    electronProcess.stdout?.on('data', (data) => {
      if (!stdoutReceived) {
        verboseLog(
          '[DEBUG][HYP-G] First stdout data received at',
          Date.now() - launchStartTime,
          'ms'
        );
        stdoutReceived = true;
      }
      const str = data.toString();
      appendElectronOutput(outputBuffer.stdout, str);
      printElectronOutput('[Electron Stdout]: ', str, console.log);
    });
    electronProcess.stderr?.on('data', (data) => {
      if (!stderrReceived) {
        verboseLog(
          '[DEBUG][HYP-G] First stderr data received at',
          Date.now() - launchStartTime,
          'ms'
        );
        stderrReceived = true;
      }
      const str = data.toString();
      appendElectronOutput(outputBuffer.stderr, str);
      printElectronOutput('[Electron Stderr]: ', str, console.error);
    });
    // #endregion

    // #region No-output launch heartbeat
    const heartbeatInterval = setInterval(() => {
      const elapsed = Date.now() - launchStartTime;
      if (stdoutReceived || stderrReceived || elapsed < 15_000) {
        return;
      }
      verboseLog(
        `[DEBUG][HYP-H] Heartbeat: ${elapsed}ms elapsed, stdout=${stdoutReceived}, stderr=${stderrReceived}`
      );
    }, 5000);
    // Clear heartbeat on process exit
    electronProcess.on('exit', () => clearInterval(heartbeatInterval));
    // #endregion

    electronProcess.on('exit', (code, signal) => {
      const elapsed = Date.now() - launchStartTime;
      console.log(
        `[Electron Process Exit] Code: ${code}, Signal: ${signal}, Elapsed: ${elapsed}ms`
      );
      // #region Rapid-exit diagnostics
      if (elapsed < 2000) {
        verboseLog(
          '[DEBUG][HYP-E] RAPID EXIT: Process exited within 2 seconds - likely startup failure'
        );
      }
      // #endregion
    });

    app.on('close', () => {
      if (intentionallyClosingApps.has(app)) {
        return;
      }
      console.log('⚠️ Electron app closed unexpectedly');
    });
    return app;
  } catch (error) {
    console.error('❌ Failed to launch Electron app:', error);
    // #region Launch failure diagnostics
    verboseError('[DEBUG] Launch error details:', {
      elapsed: Date.now() - launchStartTime,
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : 'unknown',
    });
    // #endregion
    throw new Error(`Failed to launch Electron app: ${error}`, { cause: error });
  }
}

/** Join the owned process, never a CDP disconnect or merely a sent signal. */
export async function closeElectronApp(
  appContext: ElectronAppContext | Pick<ElectronAppContext, 'app'>
): Promise<void> {
  const app = appContext.app;
  const process = app.process();
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }
  intentionallyClosingApps.add(app);
  let exitListener: () => void = () => undefined;
  const exited = new Promise<true>((resolve) => {
    exitListener = () => resolve(true);
    process.once('exit', exitListener);
  });
  try {
    // Hidden windows retain their command listeners until app-owned retirement.
    const graceful = app.close().then(() => exited);
    const joined = await waitForWithTimeout(
      graceful,
      electronAppCloseTimeoutMs,
      'Electron app close'
    );
    if (joined) {
      return;
    }
    throw new Error('Electron did not complete application-owned shutdown');
  } catch (closeError) {
    try {
      if (process.exitCode === null && process.signalCode === null) {
        const failure = Promise.withResolvers<never>();
        const onError = (error: Error): void => failure.reject(error);
        process.once('error', onError);
        try {
          process.kill('SIGTERM');
          const joined = await waitForWithTimeout(
            Promise.race([exited, failure.promise]),
            5000,
            'Electron SIGTERM exit'
          );
          if (!joined) {
            throw new Error('Electron process remains alive after SIGTERM; preserve its profile');
          }
        } finally {
          process.off('error', onError);
        }
      }
    } catch (retireError) {
      throw new AggregateError(
        [closeError, retireError],
        'Electron shutdown and retirement failed'
      );
    }
    // Retirement must not turn a broken graceful-shutdown test green.
    throw closeError;
  } finally {
    process.off('exit', exitListener);
    intentionallyClosingApps.delete(app);
  }
}

async function waitForWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`${label} timed out after ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForAppReady(page: Page): Promise<void> {
  const appReadyTimeoutMs = 90_000;
  try {
    // First check if the page is still open
    if (page.isClosed()) {
      throw new Error('Page was closed before app could become ready');
    }

    await page.waitForFunction(() => document.readyState === 'complete', {
      timeout: appReadyTimeoutMs,
    });

    const readinessCheck = () => {
      const readyFlag = Boolean(
        Reflect.get(window as unknown as Record<string, unknown>, '__BRAINSTRIKE_READY__')
      );
      if (!readyFlag) {
        return false;
      }

      const root = document.querySelector<HTMLElement>('#root');
      return Boolean(root?.isConnected);
    };

    const isCodex = process.env['CODEX_ENV'] === 'true';

    if (isCodex) {
      const pollInterval = 100;
      const maxAttempts = Math.ceil(appReadyTimeoutMs / pollInterval);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (page.isClosed()) {
          throw new Error('Page was closed while waiting for app to become ready');
        }

        const isReady = await page.evaluate(readinessCheck);
        if (isReady) {
          verboseLog('✅ App is ready and responsive (Codex environment)');
          return;
        }

        await page.waitForTimeout(pollInterval);
      }

      throw new Error('Timed out waiting for app readiness in Codex environment');
    }

    await page.waitForFunction(readinessCheck, { polling: 100, timeout: appReadyTimeoutMs });
    verboseLog('✅ App is ready and responsive');
  } catch (error) {
    console.error('❌ Error waiting for app to be ready:', error);

    // Provide more context about the error
    if (
      error instanceof Error &&
      error.message.includes('Target page, context or browser has been closed')
    ) {
      throw new Error('App window was closed unexpectedly during initialization');
    }

    const readinessContext = await page
      .evaluate(() => {
        const root = document.querySelector<HTMLElement>('#root');
        return {
          documentReadyState: document.readyState,
          hasReadyFlag: Boolean(
            Reflect.get(window as unknown as Record<string, unknown>, '__BRAINSTRIKE_READY__')
          ),
          hasRoot: Boolean(root),
          rootChildCount: root?.childElementCount ?? 0,
          rootIsConnected: Boolean(root?.isConnected),
          visibilityState: document.visibilityState,
        };
      })
      .catch(() => null);

    throw new Error(
      `App failed to become ready: ${error}${
        readinessContext ? ` | context=${JSON.stringify(readinessContext)}` : ''
      }`
    );
  }
}

export async function noteRendererReloadIntent(page: Page, reason: string): Promise<void> {
  await page.evaluate((reloadReason: string) => {
    const lifecycle = (
      window as Window & {
        desktopLifecycle?: {
          noteReloadIntent?: (reason: string) => Promise<void>;
        };
      }
    ).desktopLifecycle;

    if (!lifecycle?.noteReloadIntent) {
      throw new Error('desktopLifecycle.noteReloadIntent is unavailable');
    }

    return lifecycle.noteReloadIntent(reloadReason);
  }, reason);
}

export async function reloadRenderer(page: Page, reason: string): Promise<void> {
  await noteRendererReloadIntent(page, reason);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
}

export async function resetAppState(window: Page): Promise<void> {
  await noteRendererReloadIntent(window, 'playwright-reset-state-clear');

  await window.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();

    // Clear persistent backend storage (electron-store/adapter)
    // This ensures no "last folder" state persists between tests
    const electronAPI = (
      window as unknown as {
        electronAPI?: { storage?: { clear?: () => Promise<void> } };
      }
    ).electronAPI;

    if (!electronAPI?.storage?.clear) {
      throw new Error('electronAPI.storage.clear is unavailable during desktop E2E reset');
    }

    await electronAPI.storage.clear();
  });
}

export async function getAppVersion(app: ElectronApplication): Promise<string> {
  return await app.evaluate(async ({ app }) => app.getVersion());
}

export async function getAppPath(app: ElectronApplication): Promise<string> {
  return await app.evaluate(async ({ app }) => app.getAppPath());
}

export async function triggerMenuAction(app: ElectronApplication, menuId: string): Promise<void> {
  await app.evaluate(async ({ Menu }, id) => {
    const menu = Menu.getApplicationMenu();
    if (menu) {
      const menuItem = menu.getMenuItemById(id);
      if (menuItem) {
        menuItem.click();
      }
    }
  }, menuId);
}

export async function waitForNewWindow(app: ElectronApplication): Promise<Page> {
  const windowPromise = app.waitForEvent('window');
  return await windowPromise;
}

export async function isDevMode(app: ElectronApplication): Promise<boolean> {
  return await app.evaluate(async ({ app }) => !app.isPackaged);
}

export async function setupDialogMocking(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ dialog }, verboseLogging: boolean) => {
    dialog.showOpenDialog = async (options) => {
      if (verboseLogging) {
        console.log('🔸 Mocked showOpenDialog called with options:', options);
      }
      return { canceled: false, filePaths: ['/mock/test/directory'] };
    };
    dialog.showSaveDialog = async (options) => {
      if (verboseLogging) {
        console.log('🔸 Mocked showSaveDialog called with options:', options);
      }
      return { canceled: false, filePath: '/mock/test/file.txt' };
    };
    dialog.showMessageBox = async (options) => {
      if (verboseLogging) {
        console.log('🔸 Mocked showMessageBox called with options:', options);
      }
      return { checkboxChecked: false, response: 0 };
    };
    dialog.showErrorBox = (title, content) => {
      if (verboseLogging) {
        console.log('🔸 Mocked showErrorBox called:', { content, title });
      }
    };
    if (dialog.showCertificateTrustDialog) {
      dialog.showCertificateTrustDialog = async (...args: unknown[]) => {
        if (verboseLogging) {
          console.log('🔸 Mocked showCertificateTrustDialog called with args:', args);
        }
      };
    }
  }, isVerboseE2eLoggingEnabled);
}

export async function mockFileSystemOperations(window: Page): Promise<void> {
  await window.evaluate((verboseLogging: boolean) => {
    const electronAPI = (
      window as unknown as {
        electronAPI?: { fileSystem?: Record<string, unknown> };
      }
    ).electronAPI;

    if (electronAPI?.fileSystem) {
      if (verboseLogging) {
        console.log('🔸 Setting up file system API mocks...');
      }
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.requestDirectoryAccess = async () => {
        if (verboseLogging) {
          console.log('🔸 Mocked requestDirectoryAccess called');
        }
        return {
          ok: true,
          value: {
            id: 'mock-directory-handle',
            kind: 'directory',
            name: 'mock-test-directory',
            path: '/mock/test/directory',
            platform: 'electron',
            type: 'directory',
          },
        };
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.exists = async (p: string) => {
        if (verboseLogging) {
          console.log('🔸 Mocked exists called with path:', p);
        }
        return { ok: true, value: p.includes('/mock/') };
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.readDirectory = async (_p: string) => {
        const rootPath = '/mock/test/directory';
        if (verboseLogging) {
          console.log('🔸 Mocked readDirectory called with path:', _p);
        }
        return { ok: true, value: getTestDirectoryStructure(rootPath) };
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.readFile = async (_p: string) => {
        if (verboseLogging) {
          console.log('🔸 Mocked readFile called with path:', _p);
        }
        return { ok: true, value: 'Mock file content for testing' };
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.writeFile = async (p: string, content: string) => {
        if (verboseLogging) {
          console.log(
            '🔸 Mocked writeFile called with path:',
            p,
            'content length:',
            content.length
          );
        }
        return true;
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.watchDirectory = async (p: string) => {
        if (verboseLogging) {
          console.log('🔸 Mocked watchDirectory called with path:', p);
        }
        return {
          unwatch: () => {
            if (verboseLogging) {
              console.log('🔸 Mocked unwatch called');
            }
          },
        };
      };
    } else if (verboseLogging) {
      console.log('🔸 No electronAPI.fileSystem found to mock');
    }

    const w = window as unknown as { showDirectoryPicker?: () => Promise<unknown> };
    if (w.showDirectoryPicker) {
      w.showDirectoryPicker = async () => {
        if (verboseLogging) {
          console.log('🔸 Mocked showDirectoryPicker called');
        }
        return { kind: 'directory', name: 'mock-directory' };
      };
    }
  }, isVerboseE2eLoggingEnabled);
}
