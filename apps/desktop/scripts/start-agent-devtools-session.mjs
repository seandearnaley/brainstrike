import { execFile, spawn, spawnSync } from 'node:child_process';
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
const DEFAULT_AGENT_DEBUG_ENDPOINT_TIMEOUT_MS = 30_000;
const WINDOWS_AGENT_DEBUG_ENDPOINT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;
const PROCESS_TREE_POLL_INTERVAL_MS = 50;
const PROCESS_TREE_TERM_GRACE_MS = 2000;
const PROCESS_TREE_KILL_GRACE_MS = 2000;
const PROFILE_REMOVAL_RETRIES = 3;
const PROFILE_REMOVAL_RETRY_DELAY_MS = 150;
const PROFILE_PREFIX = 'brainstrike-agent-devtools-';
export const PNPM_SHIM_PREFIX = 'brainstrike-agent-pnpm-';
const UNMANAGED_WINDOWS_SHIM_PLATFORM = 'win32-unmanaged-preflight';
const OWNER_MARKER_FILENAME = 'agent-devtools-owner.json';
const LEGACY_REPORT_LIMIT = 10;
// `os.uptime()` has second granularity; require a marker to predate the boot by
// a clear margin so a freshly written one is never mistaken for a pre-boot one.
const BOOT_TIME_MARGIN_MS = 60_000;
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

export function resolveAgentDebugEndpointTimeoutMs(platform = process.platform) {
  return platform === 'win32'
    ? WINDOWS_AGENT_DEBUG_ENDPOINT_TIMEOUT_MS
    : DEFAULT_AGENT_DEBUG_ENDPOINT_TIMEOUT_MS;
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
  const timeoutMs = options.timeoutMs ?? resolveAgentDebugEndpointTimeoutMs();
  while (Date.now() - startedAt < timeoutMs) {
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

export function resolvePnpmSpawnOptions(platform = process.platform) {
  return { detached: platform !== 'win32' };
}

export function resolvePnpmInvocation({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  const npmExecPath = env.npm_execpath;
  if (typeof npmExecPath === 'string') {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const entrypoint = pathApi.basename(npmExecPath).toLowerCase();
    if (
      pathApi.isAbsolute(npmExecPath) &&
      (entrypoint === 'pnpm.cjs' || entrypoint === 'pnpm.js' || entrypoint === 'pnpm.mjs')
    ) {
      return { argsPrefix: [npmExecPath], command: execPath };
    }
    throw new Error(
      'Agent DevTools npm_execpath must point to an absolute pnpm.cjs, pnpm.js, or pnpm.mjs entry.'
    );
  }
  if (platform === 'win32') {
    throw new Error(
      'Agent DevTools must be launched through pnpm on Windows so its executable path is known.'
    );
  }
  return { argsPrefix: [], command: 'pnpm' };
}

export async function createWindowsPnpmShimEnvironment({
  env = process.env,
  invocation,
  makeTempDir = fs.mkdtemp,
  platform = process.platform,
} = {}) {
  const descendantEnv = { ...env };
  if (platform !== 'win32') {
    return { cleanup: async () => {}, directory: null, env: descendantEnv };
  }

  if (
    typeof invocation?.command !== 'string' ||
    invocation.argsPrefix?.length !== 1 ||
    typeof invocation.argsPrefix[0] !== 'string'
  ) {
    throw new Error(
      'Agent DevTools cannot pin Windows pnpm descendants without a validated invocation.'
    );
  }

  const quoteBatchPath = (value) => {
    if (/["\r\n]/u.test(value)) {
      throw new Error('Agent DevTools pnpm descendant paths cannot contain quotes or newlines.');
    }
    return `"${value.replaceAll('%', '%%')}"`;
  };
  const nodeCommand = quoteBatchPath(invocation.command);
  const pnpmEntrypoint = quoteBatchPath(invocation.argsPrefix[0]);
  const shimDir = await makeTempDir(path.join(os.tmpdir(), PNPM_SHIM_PREFIX));
  try {
    // Preflight children start before the Windows Job Object exists. Keep this
    // marker deliberately unmanaged so a later sweep retains the shim if the
    // launcher dies while one of those descendants may still need it.
    await writeProfileOwnerMarker(shimDir, { platform: UNMANAGED_WINDOWS_SHIM_PLATFORM });
    const shimPath = path.join(shimDir, 'pnpm.cmd');
    await fs.writeFile(
      shimPath,
      `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${nodeCommand} ${pnpmEntrypoint} %*\r\n`,
      'utf8'
    );
  } catch (setupError) {
    try {
      await fs.rm(shimDir, { force: true, recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        `Agent DevTools pnpm shim setup and cleanup both failed for ${shimDir}.`
      );
    }
    throw setupError;
  }

  const pathKey = Object.keys(descendantEnv).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  descendantEnv[pathKey] = descendantEnv[pathKey]
    ? `${shimDir};${descendantEnv[pathKey]}`
    : shimDir;

  return {
    cleanup: () => fs.rm(shimDir, { force: true, recursive: true }),
    directory: shimDir,
    env: descendantEnv,
  };
}

export async function markWindowsPnpmShimManaged(directory, platform = process.platform) {
  if (platform !== 'win32') {
    return;
  }
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error('Agent DevTools cannot manage a Windows pnpm shim without its directory.');
  }
  // The caller promotes ownership only after every preflight has exited and
  // the Job Object is initialized, making launcher-pid liveness authoritative.
  await writeProfileOwnerMarker(directory, { platform: 'win32' });
}

export function getAgentDebugPnpmPreflightCommands() {
  return [
    ['run', 'predev'],
    ['exec', 'install-electron'],
  ];
}

function spawnPnpm(args, env, platform = process.platform, invocation = resolvePnpmInvocation()) {
  return spawn(invocation.command, [...invocation.argsPrefix, ...args], {
    cwd: path.resolve(import.meta.dirname, '..'),
    ...resolvePnpmSpawnOptions(platform),
    env,
    stdio: 'inherit',
  });
}

export function captureChildSpawnError(child) {
  const capture = {
    error: null,
    stop() {
      child.off('error', onError);
    },
  };
  function onError(error) {
    capture.error ??= error;
  }
  child.once('error', onError);
  return capture;
}

export function runPnpmCommandSync(
  args,
  env,
  { invocation = resolvePnpmInvocation(), spawnSyncImpl = spawnSync } = {}
) {
  const result = spawnSyncImpl(invocation.command, [...invocation.argsPrefix, ...args], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`Agent DevTools could not start pnpm ${args.join(' ')}.`, {
      cause: result.error,
    });
  }
  if (result.signal) {
    throw new Error(`Agent DevTools pnpm ${args.join(' ')} was terminated by ${result.signal}.`);
  }
  if (result.status !== 0) {
    throw new Error(`Agent DevTools pnpm ${args.join(' ')} exited with code ${result.status}.`);
  }
}

export function initializeWindowsJob(platform = process.platform, load = require) {
  if (platform !== 'win32') {
    return;
  }
  let windowsJob;
  try {
    windowsJob = load('@brainstrike/windows-job-native');
  } catch (error) {
    throw new Error('Agent DevTools cannot start on Windows without its Job Object capability.', {
      cause: error,
    });
  }
  if (
    typeof windowsJob?.initialize !== 'function' ||
    typeof windowsJob.activeProcessCount !== 'function' ||
    typeof windowsJob.terminateOtherProcesses !== 'function'
  ) {
    throw new Error('Agent DevTools Windows Job Object capability has an invalid interface.');
  }
  windowsJob.initialize();
  return windowsJob;
}

/**
 * Remove the disposable profile directory, verifying it is actually gone.
 *
 * A bare recursive `fs.rm` is not sufficient here. It removes leaves before
 * their parents, and a still-exiting Electron descendant can recreate cache
 * directories underneath the walk after it has passed them. The removal then
 * reports success while an empty directory skeleton survives — observed in
 * practice as profiles containing zero files but a full directory tree,
 * accumulating roughly one per agent-debug run.
 *
 * Re-check after each attempt and retry, then fail loudly. A profile left on
 * disk must surface as an error rather than a silent leak, per the cleanup
 * contract in docs/agents/ci-quality.md.
 */
export async function removeUserDataDir(userDataDir, options = {}) {
  const retries = options.retries ?? PROFILE_REMOVAL_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? PROFILE_REMOVAL_RETRY_DELAY_MS;
  const rm =
    options.rm ??
    ((target) =>
      fs.rm(target, {
        force: true,
        maxRetries: PROFILE_REMOVAL_RETRIES,
        recursive: true,
        retryDelay: PROFILE_REMOVAL_RETRY_DELAY_MS,
      }));
  const exists = options.exists ?? pathExists;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await rm(userDataDir);
      if (!(await exists(userDataDir))) {
        return;
      }
    } catch (error) {
      // The same racing descendant shows up two ways: it can recreate the tree
      // after a sweep succeeds, or recreate a subdirectory mid-walk so that
      // rmdir of the now-non-empty parent throws ENOTEMPTY/EBUSY. `force` only
      // suppresses ENOENT, so treat a throw as "still there" and give the
      // descendant time to finish exiting. Rethrow on the last attempt so a
      // genuine failure stays loud.
      if (attempt === retries) {
        throw error;
      }
    }
    if (attempt < retries) {
      await sleep(retryDelayMs);
    }
  }

  throw new Error(
    `Agent DevTools profile ${userDataDir} still exists after ${retries + 1} removal attempts.`
  );
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record which launcher owns a profile, so a later run can tell an abandoned
 * profile from a concurrent session.
 *
 * The marker lives at the profile root, which is also `BRAINSTRIKE_DB_ROOT_PATH`.
 * That is safe because the database only ever joins `<root>/profiles/<profile>`
 * onto this path and never enumerates the root itself.
 */
export async function writeProfileOwnerMarker(userDataDir, overrides = {}) {
  const marker = {
    pgid: null,
    pid: process.pid,
    platform: process.platform,
    startedAtMs: Date.now(),
    ...overrides,
  };
  await fs.writeFile(
    path.join(userDataDir, OWNER_MARKER_FILENAME),
    `${JSON.stringify(marker, null, 2)}\n`
  );
  return marker;
}

/**
 * Read a profile's owner marker, or null when the profile cannot prove who owns
 * it. A missing or malformed marker is not an error: profiles created before
 * this marker existed are legitimately markerless, and a launcher killed
 * between `mkdtemp` and the marker write leaves a half-built one. Both are
 * reported rather than removed, because neither can be proven abandoned.
 */
export async function readProfileOwnerMarker(userDataDir) {
  let raw;
  try {
    raw = await fs.readFile(path.join(userDataDir, OWNER_MARKER_FILENAME), 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0) {
      return null;
    }
    return {
      pgid: Number.isInteger(parsed?.pgid) && parsed.pgid > 0 ? parsed.pgid : null,
      pid: parsed.pid,
      platform: typeof parsed?.platform === 'string' ? parsed.platform : null,
      startedAtMs: Number.isInteger(parsed?.startedAtMs) ? parsed.startedAtMs : null,
    };
  } catch {
    return null;
  }
}

/**
 * Wall-clock time of the current boot. A marker written before it cannot
 * describe a running process, whatever its recorded pid now probes as.
 */
export function resolveBootTimeMs(uptime = os.uptime, now = Date.now) {
  return now() - uptime() * 1000;
}

/**
 * Probe whether a recorded owner is still running. Every uncertain answer must
 * resolve to "alive" so the sweep can only ever under-delete: a recycled pid or
 * a pid owned by another user (EPERM) protects a profile that might be live,
 * where the cost is a retained directory rather than a destroyed session.
 */
export function isOwnerAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/**
 * Reclaim sibling profiles whose owning launcher is provably gone.
 *
 * The in-process cleanup path covers every exit this launcher can observe, but
 * SIGKILL, a panic, and loss of power cannot run a handler at all, and nothing
 * reclaims `$TMPDIR` while a machine stays up — 121 profiles totalling 262 GB
 * had accumulated over a single eleven-day uptime when this was written.
 * Because the profile doubles as `BRAINSTRIKE_DB_ROOT_PATH`, each abandoned one
 * holds an entire PGlite cluster, so the leak is measured in gigabytes rather
 * than kilobytes.
 *
 * This is opportunistic hygiene, not the ownership guarantee. It removes only
 * what it can prove is dead, and never fails a launch: the run's own profile
 * stays fail-loud through `removeUserDataDir`, while anything found here that
 * resists removal is reported to the caller and left alone.
 *
 * A dead launcher pid is NOT sufficient proof on POSIX. `pnpm dev` is spawned
 * detached, so SIGKILLing the launcher leaves the whole tree reparented and
 * still writing to `BRAINSTRIKE_DB_ROOT_PATH` -- which is this directory.
 * Reclaiming on the pid alone would `rm -rf` a live PGlite cluster, and on
 * macOS would also delete the running app's own `electron-dist` bundle. The
 * owned process group must be proven empty as well.
 */
export async function sweepStaleProfiles(options = {}) {
  const {
    bootTimeMs = resolveBootTimeMs(),
    currentUserDataDir,
    hasLiveProcessGroupMembers: groupHasMembers = hasLiveProcessGroupMembers,
    isOwnerAlive: ownerAlive = isOwnerAlive,
    prefix = PROFILE_PREFIX,
    removeProfile = removeUserDataDir,
    tempDirectory = os.tmpdir(),
  } = options;
  const result = { failed: [], legacy: [], removed: [], scanError: null, skippedLive: [] };

  let entries;
  try {
    entries = await fs.readdir(tempDirectory, { withFileTypes: true });
  } catch (error) {
    result.scanError = error;
    return result;
  }

  const owned = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(tempDirectory, entry.name))
    .sort();

  for (const userDataDir of owned) {
    if (currentUserDataDir && path.resolve(userDataDir) === path.resolve(currentUserDataDir)) {
      continue;
    }

    const marker = await readProfileOwnerMarker(userDataDir);
    if (!marker) {
      result.legacy.push(userDataDir);
      continue;
    }

    const disposition = await classifyProfile(marker, {
      bootTimeMs,
      groupHasMembers,
      ownerAlive,
    });
    if (disposition !== 'reclaim') {
      result[disposition].push(userDataDir);
      continue;
    }

    try {
      await removeProfile(userDataDir);
      result.removed.push(userDataDir);
    } catch (error) {
      result.failed.push({ error, userDataDir });
    }
  }

  return result;
}

/**
 * Decide what a marked profile is: `reclaim`, `skippedLive` (something owning
 * it is still running), or `legacy` (staleness cannot be proven, so a human
 * decides). Order matters -- the boot boundary is checked before any pid probe
 * because pids are re-issued from a low watermark after a reboot, and a stale
 * marker that collides with an unrelated live process would otherwise make its
 * profile permanently unreclaimable.
 */
async function classifyProfile(marker, { bootTimeMs, groupHasMembers, ownerAlive }) {
  if (marker.startedAtMs !== null && marker.startedAtMs < bootTimeMs - BOOT_TIME_MARGIN_MS) {
    return 'reclaim';
  }
  if (ownerAlive(marker.pid)) {
    return 'skippedLive';
  }
  if (marker.platform === 'win32') {
    // Descendants inherit a non-breakaway Job Object with KILL_ON_JOB_CLOSE,
    // so no tree can outlive the launcher there.
    return 'reclaim';
  }
  if (marker.pgid === null) {
    // Killed between `mkdtemp` and the post-spawn marker update. A detached
    // tree may exist with no handle on it, so removal is not provable.
    return 'legacy';
  }
  return (await groupHasMembers(marker.pgid)) ? 'skippedLive' : 'reclaim';
}

export function reportSweep(
  result,
  log = console.log,
  logError = console.error,
  { prefix = PROFILE_PREFIX, resourceName = 'profile' } = {}
) {
  if (result.scanError) {
    logError(`Agent DevTools could not scan for stale ${resourceName}s:`, result.scanError);
  }
  if (result.removed.length > 0) {
    log(`Agent DevTools reclaimed ${result.removed.length} abandoned ${resourceName}(s).`);
  }
  if (result.skippedLive.length > 0) {
    // Skipping is the safe answer, but a machine where the sweep never reclaims
    // anything must not look identical to one with nothing to reclaim.
    log(
      `Agent DevTools left ${result.skippedLive.length} ${resourceName}(s) still in use by a running ` +
        'launcher or an orphaned process tree.'
    );
  }
  for (const { error, userDataDir } of result.failed) {
    logError(`Agent DevTools could not reclaim abandoned ${resourceName} ${userDataDir}:`, error);
  }
  if (result.legacy.length > 0) {
    // These predate the owner marker, so staleness cannot be proven. Surface
    // them for an explicit decision instead of guessing.
    //
    // Every path is listed in full and never collapsed to a `PROFILE_PREFIX*`
    // glob: such a glob also matches the profile of any session running right
    // now, so pasting it would destroy a live database. An exact list is the
    // only form of this report that is safe to act on.
    log(
      `Agent DevTools found ${result.legacy.length} ${resourceName}(s) with no ownership marker. ` +
        'These predate ownership tracking, cannot be proven abandoned, and were left ' +
        'untouched. Remove any you recognise as finished:'
    );
    for (const userDataDir of result.legacy.slice(0, LEGACY_REPORT_LIMIT)) {
      log(`  ${userDataDir}`);
    }
    const remaining = result.legacy.length - LEGACY_REPORT_LIMIT;
    if (remaining > 0) {
      // A glob is safe to suggest for listing, never for removal.
      log(
        `  ...and ${remaining} more; list them all with:\n` +
          `    ls -d ${path.join(os.tmpdir(), `${prefix}*`)}`
      );
    }
  }
}

export async function createAgentDevtoolsProfile(options = {}) {
  const {
    electronExecutablePath,
    platform = process.platform,
    tempDirectory = os.tmpdir(),
  } = options;
  const userDataDir = await fs.mkdtemp(path.join(tempDirectory, PROFILE_PREFIX));

  try {
    // Claim ownership before anything else can fail, so a profile that outlives
    // this launcher is always attributable to a pid a later sweep can probe.
    await writeProfileOwnerMarker(userDataDir);
    const electronOverrideDistPath =
      platform === 'darwin'
        ? await createMacAgentDebugElectronDist({
            electronExecutablePath: electronExecutablePath ?? resolveElectronExecutablePath(),
            userDataDir,
          })
        : null;
    return { electronOverrideDistPath, userDataDir };
  } catch (setupError) {
    try {
      await fs.rm(userDataDir, { force: true, recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        `Agent DevTools setup failed and profile cleanup also failed for ${userDataDir}.`
      );
    }
    throw setupError;
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

export async function waitForEndpointOrChildExit(endpoint, child, spawnErrorCapture) {
  if (spawnErrorCapture?.error) {
    spawnErrorCapture.stop();
    throw new Error(`dev server failed to start before ${endpoint} was ready.`, {
      cause: spawnErrorCapture.error,
    });
  }
  if (!isChildRunning(child)) {
    throw new Error(
      `${describeChildExit(child.exitCode, child.signalCode)} before ${endpoint} was ready.`
    );
  }

  const controller = new AbortController();
  let onExit;
  let onError;
  const childExit = new Promise((_, reject) => {
    onExit = (code, signal) => {
      reject(new Error(`${describeChildExit(code, signal)} before ${endpoint} was ready.`));
    };
    onError = (error) => {
      reject(
        new Error(`dev server failed to start before ${endpoint} was ready.`, { cause: error })
      );
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
  // Transfer error ownership only after the waiter is attached, leaving no
  // next-tick gap in which a failed spawn could become an unhandled event.
  spawnErrorCapture?.stop();

  try {
    await Promise.race([waitForEndpoint(endpoint, { signal: controller.signal }), childExit]);
  } finally {
    controller.abort();
    if (onExit) {
      child.off('exit', onExit);
    }
    if (onError) {
      child.off('error', onError);
    }
  }
}

function hasLiveProcessGroupMembers(pid) {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,pgid=,state='],
      { maxBuffer: 2_000_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const liveMember = stdout.split('\n').some((line) => {
          const [, groupText, state] = line.trim().split(/\s+/u);
          return Number(groupText) === pid && state !== undefined && !state.startsWith('Z');
        });
        resolve(liveMember);
      }
    );
  });
}

async function isProcessGroupRunning(pid) {
  // Signal 0 still reports an all-zombie group as present. Enumerate the exact
  // owned pgid on every poll so an unreaped descendant cannot exhaust both
  // grace periods after every live process has already stopped.
  return await hasLiveProcessGroupMembers(pid);
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (await isProcessGroupRunning(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(PROCESS_TREE_POLL_INTERVAL_MS);
  }
  return true;
}

export function signalProcessGroup(pid, signal, kill = process.kill) {
  try {
    kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    if (error.code === 'EPERM') {
      // Darwin may report EPERM for a mixed Electron group after a prior
      // signal. The group still exists; let the bounded membership poll decide
      // whether cleanup succeeded or must fail visibly.
      return true;
    }
    throw error;
  }
}

function readWindowsJobActiveProcessCount(windowsJob) {
  const activeProcessCount = windowsJob.activeProcessCount();
  if (!Number.isSafeInteger(activeProcessCount) || activeProcessCount < 1) {
    throw new Error(
      `Agent DevTools Windows Job Object returned invalid active process count ${activeProcessCount}.`
    );
  }
  return activeProcessCount;
}

async function waitForWindowsJobExit(windowsJob, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (readWindowsJobActiveProcessCount(windowsJob) > 1) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(PROCESS_TREE_POLL_INTERVAL_MS);
  }
  return true;
}

async function forceWindowsJobExit(windowsJob, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (readWindowsJobActiveProcessCount(windowsJob) > 1) {
    windowsJob.terminateOtherProcesses(1);
    if (readWindowsJobActiveProcessCount(windowsJob) <= 1) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(PROCESS_TREE_POLL_INTERVAL_MS);
  }
  return true;
}

/**
 * Stop only the detached process tree owned by this launcher and wait until it
 * is gone. On POSIX, the direct child is its process-group leader, so the group
 * remains addressable even when that child exits before a late-writing
 * grandchild. Windows descendants inherit the launcher's Job Object, which
 * remains authoritative after an intermediate parent exits.
 */
export async function shutdownChildProcessTree(child, platform = process.platform, options = {}) {
  if (platform === 'win32') {
    const { windowsJob } = options;
    if (!windowsJob) {
      throw new Error('Cannot stop Agent DevTools on Windows without its Job Object capability.');
    }
    const termGraceMs = options.termGraceMs ?? PROCESS_TREE_TERM_GRACE_MS;
    if (await waitForWindowsJobExit(windowsJob, termGraceMs)) {
      return;
    }
    const killGraceMs = options.killGraceMs ?? PROCESS_TREE_KILL_GRACE_MS;
    if (!(await forceWindowsJobExit(windowsJob, killGraceMs))) {
      throw new Error('Agent DevTools Windows Job Object did not stop after forced termination.');
    }
    return;
  }

  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    if (isChildRunning(child)) {
      throw new Error('Cannot stop the Agent DevTools process tree without a child pid.');
    }
    return;
  }

  if (!signalProcessGroup(pid, 'SIGTERM')) {
    return;
  }
  if (await waitForProcessGroupExit(pid, PROCESS_TREE_TERM_GRACE_MS)) {
    return;
  }
  signalProcessGroup(pid, 'SIGKILL');
  if (!(await waitForProcessGroupExit(pid, PROCESS_TREE_KILL_GRACE_MS))) {
    throw new Error(`Agent DevTools process group ${pid} did not stop after SIGKILL.`);
  }
}

export async function cleanupChildAndProfile(child, userDataDir, options = {}) {
  await shutdownChildProcessTree(child, options.platform, options);
  await (options.removeUserDataDir ?? removeUserDataDir)(userDataDir);
}

export async function cleanupAgentDebugSession(child, userDataDir, options = {}) {
  const { afterCleanup, ...childCleanupOptions } = options;
  let cleanupError;
  try {
    await cleanupChildAndProfile(child, userDataDir, childCleanupOptions);
  } catch (error) {
    cleanupError = error;
  }

  try {
    await afterCleanup?.();
  } catch (error) {
    if (cleanupError) {
      throw new AggregateError(
        [cleanupError, error],
        `Agent DevTools could not fully clean up profile ${userDataDir}.`
      );
    }
    throw error;
  }

  if (cleanupError) {
    throw cleanupError;
  }
}

function installSignalCleanup(child, userDataDir, options = {}) {
  let cleanupStarted = false;
  const cleanup = (signal) => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    console.log(`Agent DevTools received ${signal}; stopping its owned process tree...`);
    void cleanupAgentDebugSession(child, userDataDir, options).then(
      () => process.exit(signal === 'SIGHUP' ? 129 : signal === 'SIGINT' ? 130 : 143),
      (error) => {
        console.error(`Agent DevTools shutdown failed for profile ${userDataDir}:`, error);
        process.exit(1);
      }
    );
  };
  // The outer `pnpm --filter` wrapper can close its PTY after SIGINT while this
  // child is still awaiting its detached tree. Keep SIGHUP/repeated signals from
  // restoring Node's default immediate exit until cleanup has settled.
  process.on('SIGHUP', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  return () => {
    process.off('SIGHUP', cleanup);
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

  const pnpmInvocation = resolvePnpmInvocation();
  const pnpmShim = await createWindowsPnpmShimEnvironment({ invocation: pnpmInvocation });
  try {
    for (const command of getAgentDebugPnpmPreflightCommands()) {
      runPnpmCommandSync(command, pnpmShim.env, { invocation: pnpmInvocation });
    }
    const windowsJob = initializeWindowsJob();
    await markWindowsPnpmShimManaged(pnpmShim.directory);
    const { electronOverrideDistPath, userDataDir } = await createAgentDevtoolsProfile();
    const env = {
      ...pnpmShim.env,
      BRAINSTRIKE_AGENT_DEVTOOLS: '1',
      BRAINSTRIKE_AGENT_DEVTOOLS_HOST: '127.0.0.1',
      BRAINSTRIKE_AGENT_DEVTOOLS_PORT: String(port),
      BRAINSTRIKE_DB_ROOT_PATH: userDataDir,
      BRAINSTRIKE_E2E_USER_DATA_DIR: userDataDir,
      ...(electronOverrideDistPath
        ? { ELECTRON_OVERRIDE_DIST_PATH: electronOverrideDistPath }
        : {}),
    };

    console.log(`Agent DevTools profile: ${userDataDir}`);
    console.log(`Agent DevTools endpoint: ${endpoint}`);
    if (electronOverrideDistPath) {
      console.log(
        `Agent DevTools macOS identity: ${MAC_AGENT_DEBUG_APP_NAME} (${MAC_AGENT_DEBUG_BUNDLE_ID})`
      );
    }

    const child = spawnPnpm(['run', 'dev:runtime'], env, process.platform, pnpmInvocation);
    const spawnErrorCapture = captureChildSpawnError(child);
    const cleanupOptions = windowsJob ? { windowsJob } : {};
    const uninstallSignalCleanup = installSignalCleanup(child, userDataDir, {
      ...cleanupOptions,
      afterCleanup: pnpmShim.cleanup,
    });
    try {
      // On POSIX the detached child leads its own process group, so its pid is
      // the group a later sweep must prove empty before reclaiming this profile.
      // Recorded here rather than at creation because it does not exist until
      // the spawn returns.
      if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
        await writeProfileOwnerMarker(userDataDir, { pgid: child.pid });
      }
      // Deliberately after the spawn: reclaiming other people's leftovers is
      // hygiene and must not sit in front of the dev server the user asked for.
      // It now overlaps with startup instead.
      reportSweep(await sweepStaleProfiles({ currentUserDataDir: userDataDir }));
      if (pnpmShim.directory) {
        reportSweep(
          await sweepStaleProfiles({
            currentUserDataDir: pnpmShim.directory,
            prefix: PNPM_SHIM_PREFIX,
          }),
          console.log,
          console.error,
          { prefix: PNPM_SHIM_PREFIX, resourceName: 'pnpm shim' }
        );
      }
      await waitForEndpointOrChildExit(endpoint, child, spawnErrorCapture);
      console.log('\nMCP config:\n');
      console.log(formatMcpConfig(endpoint));
      const exitCode = await waitForChildExit(child);
      process.exitCode = exitCode;
    } finally {
      spawnErrorCapture.stop();
      uninstallSignalCleanup();
      await cleanupChildAndProfile(child, userDataDir, cleanupOptions);
    }
  } finally {
    await pnpmShim.cleanup();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
