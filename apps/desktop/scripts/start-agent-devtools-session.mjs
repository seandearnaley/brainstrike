import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import agentDevToolsDefaults from '../agent-devtools-defaults.json' with { type: 'json' };

const DEFAULT_PORT = agentDevToolsDefaults.defaultPort;
const MIN_PORT = agentDevToolsDefaults.minPort;
const MAX_PORT = agentDevToolsDefaults.maxPort;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

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
          command: 'npx',
          args: [
            '-y',
            agentDevToolsDefaults.mcpPackage,
            `--browser-url=${endpoint}`,
            '--no-usage-statistics',
          ],
        },
      },
    },
    null,
    2
  );
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
    throw new Error(`${describeChildExit(child.exitCode, child.signalCode)} before ${endpoint} was ready.`);
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
  const env = {
    ...process.env,
    BRAINSTRIKE_AGENT_DEVTOOLS: '1',
    BRAINSTRIKE_AGENT_DEVTOOLS_PORT: String(port),
    BRAINSTRIKE_AGENT_DEVTOOLS_HOST: '127.0.0.1',
    BRAINSTRIKE_DB_ROOT_PATH: userDataDir,
    BRAINSTRIKE_E2E_USER_DATA_DIR: userDataDir,
  };

  console.log(`Agent DevTools profile: ${userDataDir}`);
  console.log(`Agent DevTools endpoint: ${endpoint}`);

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
