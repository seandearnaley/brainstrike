import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import agentDevToolsDefaults from '../agent-devtools-defaults.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const DEFAULT_PORT = agentDevToolsDefaults.defaultPort;
const MIN_PORT = agentDevToolsDefaults.minPort;
const MAX_PORT = agentDevToolsDefaults.maxPort;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const MAC_AGENT_DEBUG_APP_NAME = 'BrainStrike Agent Debug';
const MAC_AGENT_DEBUG_BUNDLE_ID = 'com.brainstrike.desktop.agent-debug';

export function parsePort(value) {
  const raw = value?.trim() || String(DEFAULT_PORT);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || String(port) !== raw || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`Agent DevTools port must be an integer from ${MIN_PORT} to ${MAX_PORT}.`);
  }
  return port;
}

export function resolveEndpoint(port) {
  return `http://127.0.0.1:${port}`;
}

export function formatMcpConfig(endpoint) {
  return JSON.stringify(
    {
      mcpServers: {
        'brainstrike-devtools': {
          args: [
            '-y',
            agentDevToolsDefaults.mcpPackage,
            `--browser-url=${endpoint}`,
            '--no-usage-statistics',
          ],
          command: 'npx',
        },
      },
    },
    null,
    2
  );
}

function replacePlistStringValue(plist, key, value) {
  const keyTag = `<key>${key}</key>`;
  const keyIndex = plist.indexOf(keyTag);
  if (keyIndex < 0 || plist.indexOf(keyTag, keyIndex + keyTag.length) >= 0) {
    throw new Error(`Electron Info.plist must contain exactly one ${key} key.`);
  }

  const valueStart = keyIndex + keyTag.length;
  const valueMatch = plist.slice(valueStart).match(/^(\s*)<string>[^<]*<\/string>/);
  if (!valueMatch) {
    throw new Error(`Electron Info.plist ${key} must have a string value.`);
  }

  const replacement = `${valueMatch[1]}<string>${value}</string>`;
  return `${plist.slice(0, valueStart)}${replacement}${plist.slice(
    valueStart + valueMatch[0].length
  )}`;
}

export function rewriteMacAgentDebugInfoPlist(plist) {
  let rewritten = replacePlistStringValue(plist, 'CFBundleDisplayName', MAC_AGENT_DEBUG_APP_NAME);
  rewritten = replacePlistStringValue(rewritten, 'CFBundleIdentifier', MAC_AGENT_DEBUG_BUNDLE_ID);
  return replacePlistStringValue(rewritten, 'CFBundleName', MAC_AGENT_DEBUG_APP_NAME);
}

function resolveElectronBundleContents(electronExecutablePath) {
  const macOsDir = path.dirname(electronExecutablePath);
  const contentsDir = path.dirname(macOsDir);
  const appBundleDir = path.dirname(contentsDir);
  if (
    path.basename(electronExecutablePath) !== 'Electron' ||
    path.basename(macOsDir) !== 'MacOS' ||
    path.basename(contentsDir) !== 'Contents' ||
    path.extname(appBundleDir) !== '.app'
  ) {
    throw new Error(
      `Expected a macOS Electron.app executable path, received ${electronExecutablePath}.`
    );
  }
  return contentsDir;
}

function resolveElectronExecutablePath() {
  const executablePath = require('electron');
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
    throw new Error('The Electron package did not resolve to an absolute executable path.');
  }
  return executablePath;
}

export async function createMacAgentDebugElectronDist({ electronExecutablePath, userDataDir }) {
  const originalContents = resolveElectronBundleContents(electronExecutablePath);
  const distPath = path.join(userDataDir, 'electron-dist');
  const shimContents = path.join(distPath, 'Electron.app', 'Contents');
  const shimMacOs = path.join(shimContents, 'MacOS');

  await fs.mkdir(shimMacOs, { recursive: true });
  await Promise.all([
    fs.symlink(path.join(originalContents, 'Frameworks'), path.join(shimContents, 'Frameworks')),
    fs.symlink(path.join(originalContents, 'Resources'), path.join(shimContents, 'Resources')),
    fs.symlink(electronExecutablePath, path.join(shimMacOs, 'Electron')),
    fs.copyFile(path.join(originalContents, 'PkgInfo'), path.join(shimContents, 'PkgInfo')),
  ]);

  const originalInfoPlist = await fs.readFile(path.join(originalContents, 'Info.plist'), 'utf8');
  await fs.writeFile(
    path.join(shimContents, 'Info.plist'),
    rewriteMacAgentDebugInfoPlist(originalInfoPlist)
  );
  return distPath;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Endpoint wait aborted.');
  }
}

async function sleep(ms, signal) {
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Endpoint wait aborted.'));
    };
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function waitForEndpoint(endpoint, options = {}) {
  const startedAt = Date.now();
  const url = `${endpoint}/json/version`;
  const { signal } = options;
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    throwIfAborted(signal);
    try {
      const response = await fetch(url, { signal });
      if (response.ok) {
        return;
      }
    } catch {
      throwIfAborted(signal);
      // Connection refused or other startup network errors are expected here.
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function spawnPnpm(args, env) {
  return spawn('pnpm', [...args], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env,
    stdio: 'inherit',
  });
}

async function removeUserDataDir(userDataDir) {
  try {
    await fs.rm(userDataDir, { force: true, recursive: true });
  } catch (error) {
    console.warn(`Failed to remove Agent DevTools profile ${userDataDir}:`, error);
  }
}

function isChildRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForChildExit(child) {
  if (!isChildRunning(child)) {
    return child.exitCode ?? 0;
  }
  const [code] = await once(child, 'exit');
  return typeof code === 'number' ? code : 0;
}

function describeChildExit(code, signal) {
  if (typeof code === 'number') {
    return `dev server exited with code ${code}`;
  }
  if (typeof signal === 'string') {
    return `dev server exited from signal ${signal}`;
  }
  return 'dev server exited';
}

export async function waitForEndpointOrChildExit(endpoint, child) {
  if (!isChildRunning(child)) {
    throw new Error(
      `${describeChildExit(child.exitCode, child.signalCode)} before ${endpoint} was ready.`
    );
  }

  const controller = new AbortController();
  let onExit;
  const childExit = new Promise((_, reject) => {
    onExit = (code, signal) => {
      reject(new Error(`${describeChildExit(code, signal)} before ${endpoint} was ready.`));
    };
    child.once('exit', onExit);
  });

  try {
    await Promise.race([waitForEndpoint(endpoint, { signal: controller.signal }), childExit]);
  } finally {
    controller.abort();
    if (onExit) {
      child.off('exit', onExit);
    }
  }
}

function stopChild(child) {
  if (isChildRunning(child)) {
    child.kill('SIGTERM');
  }
}

async function cleanupChildAndProfile(child, userDataDir) {
  stopChild(child);
  await removeUserDataDir(userDataDir);
}

function installSignalCleanup(child, userDataDir) {
  let cleanupStarted = false;
  const cleanup = (signal) => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    void cleanupChildAndProfile(child, userDataDir).finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  return () => {
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
  };
}

async function main() {
  const port = parsePort(process.env.BRAINSTRIKE_AGENT_DEVTOOLS_PORT);
  const endpoint = resolveEndpoint(port);
  if (process.argv.includes('--print-config')) {
    console.log(formatMcpConfig(endpoint));
    return;
  }

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-agent-devtools-'));
  const electronOverrideDistPath =
    process.platform === 'darwin'
      ? await createMacAgentDebugElectronDist({
          electronExecutablePath: resolveElectronExecutablePath(),
          userDataDir,
        })
      : null;
  const env = {
    ...process.env,
    BRAINSTRIKE_AGENT_DEVTOOLS: '1',
    BRAINSTRIKE_AGENT_DEVTOOLS_HOST: '127.0.0.1',
    BRAINSTRIKE_AGENT_DEVTOOLS_PORT: String(port),
    BRAINSTRIKE_DB_ROOT_PATH: userDataDir,
    BRAINSTRIKE_E2E_USER_DATA_DIR: userDataDir,
    ...(electronOverrideDistPath ? { ELECTRON_OVERRIDE_DIST_PATH: electronOverrideDistPath } : {}),
  };

  console.log(`Agent DevTools profile: ${userDataDir}`);
  console.log(`Agent DevTools endpoint: ${endpoint}`);
  if (electronOverrideDistPath) {
    console.log(
      `Agent DevTools macOS identity: ${MAC_AGENT_DEBUG_APP_NAME} (${MAC_AGENT_DEBUG_BUNDLE_ID})`
    );
  }

  const child = spawnPnpm(['dev'], env);
  const uninstallSignalCleanup = installSignalCleanup(child, userDataDir);
  try {
    await waitForEndpointOrChildExit(endpoint, child);
    console.log('\nMCP config:\n');
    console.log(formatMcpConfig(endpoint));
    const exitCode = await waitForChildExit(child);
    process.exitCode = exitCode;
  } finally {
    uninstallSignalCleanup();
    await cleanupChildAndProfile(child, userDataDir);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
