import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import agentDevToolsDefaults from '../../agent-devtools-defaults.json' with { type: 'json' };
import {
  captureChildSpawnError,
  cleanupAgentDebugSession,
  cleanupChildAndProfile,
  createAgentDevtoolsProfile,
  createMacAgentDebugElectronDist,
  createWindowsPnpmShimEnvironment,
  formatMcpConfig,
  getAgentDebugPnpmPreflightCommands,
  initializeWindowsJob,
  markWindowsPnpmShimManaged,
  PNPM_SHIM_PREFIX,
  parsePort,
  readProfileOwnerMarker,
  removeUserDataDir,
  reportSweep,
  resolveAgentDebugEndpointTimeoutMs,
  resolveEndpoint,
  resolvePnpmInvocation,
  resolvePnpmSpawnOptions,
  rewriteMacAgentDebugInfoPlist,
  runPnpmCommandSync,
  shutdownChildProcessTree,
  signalProcessGroup,
  sweepStaleProfiles,
  waitForEndpoint,
  waitForEndpointOrChildExit,
  writeProfileOwnerMarker,
} from '../start-agent-devtools-session.mjs';

test('allows a bounded Windows cold start without delaying failures on other platforms', () => {
  assert.equal(resolveAgentDebugEndpointTimeoutMs('win32'), 90_000);
  assert.equal(resolveAgentDebugEndpointTimeoutMs('darwin'), 30_000);
  assert.equal(resolveAgentDebugEndpointTimeoutMs('linux'), 30_000);
});

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Electron</string>
  <key>CFBundleExecutable</key>
  <string>Electron</string>
  <key>CFBundleIdentifier</key>
  <string>com.github.Electron</string>
  <key>CFBundleName</key>
  <string>Electron</string>
</dict>
</plist>
`;

function forceKillProcessGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'EPERM') {
      throw error;
    }
  }
}

test('parsePort accepts a valid explicit port', () => {
  assert.equal(parsePort('9333'), 9333);
});

test('parsePort rejects privileged or invalid ports', () => {
  assert.throws(() => parsePort('80'), /integer from 1024 to 65535/);
  assert.throws(() => parsePort('abc'), /integer from 1024 to 65535/);
});

test('resolveEndpoint returns the local browser url', () => {
  assert.equal(resolveEndpoint(agentDevToolsDefaults.defaultPort), 'http://127.0.0.1:9222');
});

test('formatMcpConfig renders chrome-devtools-mcp browser-url config', () => {
  const rendered = formatMcpConfig('http://127.0.0.1:9222');
  assert.match(rendered, /chrome-devtools-mcp@0\.26\.0/);
  assert.match(rendered, /--browser-url=http:\/\/127\.0\.0\.1:9222/);
  assert.match(rendered, /--no-usage-statistics/);
});

test('keeps the Windows dev tree in the launcher console for graceful Ctrl-C delivery', () => {
  assert.equal(resolvePnpmSpawnOptions('win32').detached, false);
  assert.equal(resolvePnpmSpawnOptions('darwin').detached, true);
});

test('re-enters the active pnpm CLI without a Windows command shim', () => {
  assert.deepEqual(
    resolvePnpmInvocation({
      env: { npm_execpath: 'C:\\tools\\pnpm.cjs' },
      execPath: 'C:\\tools\\node.exe',
      platform: 'win32',
    }),
    {
      argsPrefix: ['C:\\tools\\pnpm.cjs'],
      command: 'C:\\tools\\node.exe',
    }
  );
});

test('pins Windows pnpm descendants to the validated Node and pnpm entrypoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-agent-debug-pnpm-test-'));
  let requestedPrefix;

  try {
    const shim = await createWindowsPnpmShimEnvironment({
      env: { Path: 'C:\\global-tools' },
      invocation: {
        argsPrefix: ['C:\\active corepack\\pnpm.cjs'],
        command: 'C:\\active node\\node.exe',
      },
      makeTempDir: async (prefix) => {
        requestedPrefix = prefix;
        return root;
      },
      platform: 'win32',
    });

    assert.equal(path.basename(requestedPrefix), 'brainstrike-agent-pnpm-');
    assert.equal(path.basename(requestedPrefix).startsWith('brainstrike-agent-devtools-'), false);
    assert.equal(shim.env.Path, `${root};C:\\global-tools`);
    assert.equal(
      await readFile(path.join(root, 'pnpm.cmd'), 'utf8'),
      '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"C:\\active node\\node.exe" "C:\\active corepack\\pnpm.cjs" %*\r\n'
    );
    assert.equal('BRAINSTRIKE_AGENT_DEBUG_NODE' in shim.env, false);
    assert.equal('BRAINSTRIKE_AGENT_DEBUG_PNPM' in shim.env, false);
    assert.equal(shim.directory, root);
    const preflightMarker = await readProfileOwnerMarker(root);
    assert.equal(preflightMarker.pid, process.pid);
    assert.equal(preflightMarker.platform, 'win32-unmanaged-preflight');

    await markWindowsPnpmShimManaged(root, 'win32');
    assert.equal((await readProfileOwnerMarker(root)).platform, 'win32');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('rejects unsafe Windows batch paths before allocating a shim directory', async () => {
  let makeTempDirCalled = false;

  await assert.rejects(
    createWindowsPnpmShimEnvironment({
      invocation: {
        argsPrefix: ['C:\\active corepack\\pnpm.cjs'],
        command: 'C:\\unsafe"node\\node.exe',
      },
      makeTempDir: async () => {
        makeTempDirCalled = true;
        return 'C:\\unexpected';
      },
      platform: 'win32',
    }),
    /cannot contain quotes or newlines/
  );
  assert.equal(makeTempDirCalled, false);
});

test('uses Windows path semantics for a Windows pnpm entrypoint on every test host', () => {
  assert.deepEqual(
    resolvePnpmInvocation({
      env: { npm_execpath: 'C:\\tools\\pnpm.js' },
      execPath: 'C:\\tools\\node.exe',
      platform: 'win32',
    }),
    {
      argsPrefix: ['C:\\tools\\pnpm.js'],
      command: 'C:\\tools\\node.exe',
    }
  );
});

test('re-enters a corepack-shimmed pnpm whose entrypoint is pnpm.mjs', () => {
  const corepackExecPath = '/Users/dev/Library/Caches/node/corepack/v1/pnpm/11.15.0/bin/pnpm.mjs';
  assert.deepEqual(
    resolvePnpmInvocation({
      env: { npm_execpath: corepackExecPath },
      execPath: '/usr/local/bin/node',
      platform: 'darwin',
    }),
    {
      argsPrefix: [corepackExecPath],
      command: '/usr/local/bin/node',
    }
  );
});

test('rejects npm_execpath values that are not pnpm JavaScript entrypoints', () => {
  for (const npmExecPath of ['C:\\tools\\npm-cli.js', 'C:\\tools\\pnpm.cmd', 'tools\\pnpm.cjs']) {
    assert.throws(
      () =>
        resolvePnpmInvocation({
          env: { npm_execpath: npmExecPath },
          execPath: 'C:\\tools\\node.exe',
          platform: 'win32',
        }),
      /must point to an absolute pnpm\.cjs, pnpm\.js, or pnpm\.mjs entry/
    );
  }
});

test('fails before creating a profile when Windows is not launched through pnpm', () => {
  assert.throws(
    () =>
      resolvePnpmInvocation({
        env: {},
        execPath: 'C:\\tools\\node.exe',
        platform: 'win32',
      }),
    /must be launched through pnpm on Windows/
  );
});

test('keeps the direct pnpm executable fallback on POSIX', () => {
  assert.deepEqual(
    resolvePnpmInvocation({
      env: {},
      execPath: '/usr/bin/node',
      platform: 'linux',
    }),
    {
      argsPrefix: [],
      command: 'pnpm',
    }
  );
});

test('runs the dependency preflight through the resolved pnpm invocation', () => {
  let received;
  runPnpmCommandSync(
    ['run', 'predev'],
    { MARKER: 'value' },
    {
      invocation: {
        argsPrefix: ['C:\\tools\\pnpm.cjs'],
        command: 'C:\\tools\\node.exe',
      },
      spawnSyncImpl(command, args, options) {
        received = { args, command, options };
        return { status: 0 };
      },
    }
  );

  assert.equal(received.command, 'C:\\tools\\node.exe');
  assert.deepEqual(received.args, ['C:\\tools\\pnpm.cjs', 'run', 'predev']);
  assert.deepEqual(received.options.env, { MARKER: 'value' });
  assert.equal(received.options.stdio, 'inherit');
});

test('provisions Electron before the launcher starts its bounded CDP readiness wait', () => {
  assert.deepEqual(getAgentDebugPnpmPreflightCommands(), [
    ['run', 'predev'],
    ['exec', 'install-electron'],
  ]);
});

test('surfaces a dependency preflight failure before runtime startup', () => {
  assert.throws(
    () =>
      runPnpmCommandSync(
        ['run', 'predev'],
        {},
        {
          invocation: {
            argsPrefix: ['C:\\tools\\pnpm.cjs'],
            command: 'C:\\tools\\node.exe',
          },
          spawnSyncImpl: () => ({ status: 1 }),
        }
      ),
    /pnpm run predev exited with code 1/
  );
});

test('surfaces the signal that terminated the dependency preflight', () => {
  assert.throws(
    () =>
      runPnpmCommandSync(
        ['run', 'predev'],
        {},
        {
          invocation: {
            argsPrefix: ['C:\\tools\\pnpm.cjs'],
            command: 'C:\\tools\\node.exe',
          },
          spawnSyncImpl: () => ({ signal: 'SIGTERM', status: null }),
        }
      ),
    /pnpm run predev was terminated by SIGTERM/
  );
});

test('fails closed when the Windows Job Object capability cannot load', () => {
  assert.throws(
    () =>
      initializeWindowsJob('win32', () => {
        throw new Error('injected missing addon');
      }),
    /cannot start on Windows without its Job Object capability/
  );
});

test('initializes the Windows Job Object before returning its controller', () => {
  let initialized = false;
  const controller = {
    activeProcessCount: () => 1,
    initialize: () => {
      initialized = true;
    },
    terminateOtherProcesses: () => 0,
  };

  assert.equal(
    initializeWindowsJob('win32', () => controller),
    controller
  );
  assert.equal(initialized, true);
});

test('creates a lightweight macOS Electron shim with a unique BrainStrike identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-agent-debug-shim-test-'));
  const originalContents = path.join(root, 'original', 'Electron.app', 'Contents');
  const originalExecutable = path.join(originalContents, 'MacOS', 'Electron');
  const userDataDir = path.join(root, 'profile');

  try {
    await mkdir(path.join(originalContents, 'Frameworks'), { recursive: true });
    await mkdir(path.join(originalContents, 'MacOS'), { recursive: true });
    await mkdir(path.join(originalContents, 'Resources'), { recursive: true });
    await writeFile(originalExecutable, '');
    await writeFile(path.join(originalContents, 'Info.plist'), INFO_PLIST);
    await writeFile(path.join(originalContents, 'PkgInfo'), 'APPL????');

    const distPath = await createMacAgentDebugElectronDist({
      electronExecutablePath: originalExecutable,
      userDataDir,
    });
    const shimContents = path.join(distPath, 'Electron.app', 'Contents');

    assert.equal(
      await readlink(path.join(shimContents, 'Frameworks')),
      path.join(originalContents, 'Frameworks')
    );
    assert.equal(
      await readlink(path.join(shimContents, 'Resources')),
      path.join(originalContents, 'Resources')
    );
    assert.equal(await readlink(path.join(shimContents, 'MacOS', 'Electron')), originalExecutable);

    const infoPlist = await readFile(path.join(shimContents, 'Info.plist'), 'utf8');
    assert.match(
      infoPlist,
      /<key>CFBundleDisplayName<\/key>\s*<string>BrainStrike Agent Debug<\/string>/
    );
    assert.match(
      infoPlist,
      /<key>CFBundleIdentifier<\/key>\s*<string>com\.brainstrike\.desktop\.agent-debug<\/string>/
    );
    assert.match(infoPlist, /<key>CFBundleName<\/key>\s*<string>BrainStrike Agent Debug<\/string>/);
    assert.match(infoPlist, /<key>CFBundleExecutable<\/key>\s*<string>Electron<\/string>/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('rejects an Electron plist that cannot provide the required unique identity', () => {
  assert.throws(
    () =>
      rewriteMacAgentDebugInfoPlist(
        '<plist><dict><key>CFBundleDisplayName</key><string>Electron</string></dict></plist>'
      ),
    /exactly one CFBundleIdentifier key/
  );
});

test('removes the temporary profile when macOS identity setup fails closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-agent-debug-profile-test-'));

  try {
    await assert.rejects(
      createAgentDevtoolsProfile({
        electronExecutablePath: path.join(root, 'unexpected-electron'),
        platform: 'darwin',
        tempDirectory: root,
      }),
      /Expected a macOS Electron\.app executable path/
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('waitForEndpoint sleeps between non-ok responses', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: calls >= 2 };
  };
  const startedAt = Date.now();
  try {
    await waitForEndpoint('http://127.0.0.1:9222');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 2);
  assert.ok(Date.now() - startedAt >= 450);
});

test('waitForEndpointOrChildExit rejects when the dev server exits before the endpoint is ready', async () => {
  const originalFetch = globalThis.fetch;
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  globalThis.fetch = async () => ({ ok: false });

  const wait = waitForEndpointOrChildExit('http://127.0.0.1:9222', child);
  child.emit('exit', 1, null);

  try {
    await assert.rejects(wait, /dev server exited with code 1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('waitForEndpointOrChildExit handles spawn errors without an unhandled child error', async () => {
  const originalFetch = globalThis.fetch;
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  globalThis.fetch = async () => ({ ok: false });

  const wait = waitForEndpointOrChildExit('http://127.0.0.1:9222', child);
  child.emit('error', new Error('spawn failed'));

  try {
    await assert.rejects(wait, /dev server failed to start/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('waitForEndpointOrChildExit consumes a spawn error captured before the waiter starts', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const spawnError = new Error('spawn failed before first await');
  const capture = captureChildSpawnError(child);

  child.emit('error', spawnError);

  await assert.rejects(
    waitForEndpointOrChildExit('http://127.0.0.1:9222', child, capture),
    (error) => {
      assert.match(error.message, /dev server failed to start/);
      assert.equal(error.cause, spawnError);
      return true;
    }
  );
});

test('shutdownChildProcessTree reaps a late-writing grandchild after the direct child exits', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-agent-debug-tree-test-'));
  const profile = path.join(root, 'profile');
  const readyPath = path.join(root, 'grandchild-ready');
  const latePath = path.join(profile, 'late-write');
  await mkdir(profile);

  const grandchildSource = `
      const fs = require('node:fs');
      setTimeout(() => {
        fs.mkdirSync(${JSON.stringify(profile)}, { recursive: true });
        fs.writeFileSync(${JSON.stringify(latePath)}, 'late');
      }, 400);
      setTimeout(() => {}, 10_000);
    `;
  const childSource = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
        stdio: 'ignore',
      });
      grandchild.unref();
      fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
    `;
  const child = spawn(process.execPath, ['-e', childSource], {
    detached: true,
    stdio: 'ignore',
  });

  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(await readFile(readyPath, 'utf8'), 'ready');

    await shutdownChildProcessTree(child);
    await rm(profile, { force: true, recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 700));

    await assert.rejects(stat(profile), { code: 'ENOENT' });
  } finally {
    if (child.pid) {
      forceKillProcessGroup(child.pid);
    }
    await rm(root, { force: true, recursive: true });
  }
});

test('Windows cleanup waits for authoritative job membership after the direct child exits', async () => {
  let membershipPolls = 0;
  let terminationCalls = 0;
  const windowsJob = {
    activeProcessCount() {
      membershipPolls += 1;
      return membershipPolls === 1 ? 2 : 1;
    },
    terminateOtherProcesses() {
      terminationCalls += 1;
    },
  };

  await shutdownChildProcessTree({ exitCode: 0, pid: 42, signalCode: null }, 'win32', {
    windowsJob,
  });

  assert.equal(terminationCalls, 0);
  assert.equal(membershipPolls, 2);
});

test('Windows cleanup escalates only through the owned job after a bounded grace period', async () => {
  let terminated = false;
  const windowsJob = {
    activeProcessCount() {
      return terminated ? 1 : 2;
    },
    terminateOtherProcesses() {
      terminated = true;
    },
  };

  await shutdownChildProcessTree({ exitCode: null, pid: 42, signalCode: null }, 'win32', {
    killGraceMs: 0,
    termGraceMs: 0,
    windowsJob,
  });

  assert.equal(terminated, true);
});

test('Windows cleanup repeats owned-job termination when membership races the first sweep', async () => {
  let terminationCalls = 0;
  const windowsJob = {
    activeProcessCount() {
      return terminationCalls >= 2 ? 1 : 2;
    },
    terminateOtherProcesses() {
      terminationCalls += 1;
    },
  };

  await shutdownChildProcessTree({ exitCode: null, pid: 42, signalCode: null }, 'win32', {
    killGraceMs: 100,
    termGraceMs: 0,
    windowsJob,
  });

  assert.equal(terminationCalls, 2);
});

test('signalProcessGroup treats Darwin mixed-group EPERM as present for bounded verification', () => {
  const kill = () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };

  assert.equal(signalProcessGroup(42, 'SIGKILL', kill), true);
});

test('cleanupChildAndProfile surfaces profile removal failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-agent-debug-cleanup-test-'));
  const profile = path.join(root, 'profile');
  await mkdir(profile);
  const removalError = Object.assign(new Error('injected profile removal failure'), {
    code: 'EACCES',
  });

  try {
    await assert.rejects(
      cleanupChildAndProfile({ exitCode: 0, pid: undefined, signalCode: null }, profile, {
        platform: 'linux',
        removeUserDataDir: async () => {
          throw removalError;
        },
      }),
      removalError
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('signal cleanup still removes the pnpm shim when profile cleanup fails', async () => {
  const profileError = new Error('profile removal failed');
  let shimCleanupCalled = false;

  await assert.rejects(
    cleanupAgentDebugSession({ exitCode: 0, pid: null, signalCode: null }, 'C:\\agent-profile', {
      afterCleanup: async () => {
        shimCleanupCalled = true;
      },
      platform: 'linux',
      removeUserDataDir: async () => {
        throw profileError;
      },
    }),
    (error) => error === profileError
  );
  assert.equal(shimCleanupCalled, true);
});

test('removeUserDataDir removes a real profile tree, directories included', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-agent-debug-rm-test-'));
  const profile = path.join(root, 'profile');
  // Mirror the shape an Electron profile actually leaves behind.
  await mkdir(path.join(profile, 'session-data', 'Cache', 'Cache_Data'), { recursive: true });
  await mkdir(path.join(profile, 'profiles', 'branch-main-wt-abc123', 'pgdata'), {
    recursive: true,
  });
  await writeFile(path.join(profile, 'session-data', 'Cache', 'Cache_Data', 'entry'), 'x');

  try {
    await removeUserDataDir(profile);
    await assert.rejects(stat(profile), { code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('removeUserDataDir retries when a dying descendant recreates the directory', async () => {
  // The observed leak: `fs.rm` reports success but an exiting Electron child has
  // recreated the cache skeleton behind the walk, leaving an empty directory tree.
  let attempts = 0;
  let stillThere = true;

  await removeUserDataDir('/fake/profile', {
    exists: async () => stillThere,
    retryDelayMs: 0,
    rm: async () => {
      attempts += 1;
      // Recreated after the first sweep, genuinely gone after the second.
      if (attempts >= 2) {
        stillThere = false;
      }
    },
  });

  assert.equal(attempts, 2);
});

test('removeUserDataDir throws rather than leaking a profile that will not go away', async () => {
  let attempts = 0;

  await assert.rejects(
    removeUserDataDir('/fake/stubborn-profile', {
      exists: async () => true,
      retries: 2,
      retryDelayMs: 0,
      rm: async () => {
        attempts += 1;
      },
    }),
    /still exists after 3 removal attempts/
  );

  // Every attempt is used before giving up, and the failure is visible.
  assert.equal(attempts, 3);
});

test('removeUserDataDir retries when rm throws ENOTEMPTY from a mid-walk recreate', async () => {
  // The same race lands two ways. `fs.rm` removes leaves before parents, so a
  // descendant recreating a subdirectory mid-walk makes rmdir of the parent throw
  // ENOTEMPTY. `force` only suppresses ENOENT, so this must not become a hard exit.
  let attempts = 0;

  await removeUserDataDir('/fake/racing-profile', {
    exists: async () => false,
    retryDelayMs: 0,
    rm: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
      }
    },
  });

  assert.equal(attempts, 2);
});

test('removeUserDataDir rethrows the underlying error when every attempt throws', async () => {
  const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
  let attempts = 0;

  await assert.rejects(
    removeUserDataDir('/fake/busy-profile', {
      exists: async () => true,
      retries: 2,
      retryDelayMs: 0,
      rm: async () => {
        attempts += 1;
        throw busy;
      },
    }),
    // The real cause survives rather than being masked by the generic message.
    busy
  );

  assert.equal(attempts, 3);
});

/**
 * Build an isolated stand-in for the OS temp directory containing sibling
 * profiles in a chosen ownership state, so a sweep can be exercised without
 * touching the real tmpdir.
 */
async function createSiblingProfiles(siblings) {
  const temp = await mkdtemp(path.join(tmpdir(), 'brainstrike-agent-debug-sweep-test-'));
  const created = {};
  for (const [name, owner] of Object.entries(siblings)) {
    const profile = path.join(temp, name);
    await mkdir(path.join(profile, 'profiles', 'branch-main-wt-abc123', 'pgdata'), {
      recursive: true,
    });
    if (owner !== 'legacy') {
      // A bare number means "owned by this pid, with its process group
      // recorded" -- the shape a fully started launcher leaves behind. The pid
      // is fabricated, but `hasLiveProcessGroupMembers` resolves a pgid against
      // the HOST process table through `ps`, which does not know that. Any test
      // that stubs the owner dead must stub the group probe too; otherwise it
      // passes or fails on whether that number happens to be in use on the
      // machine. Tests that mean to exercise the real probe spawn a real
      // process and pass its pid as the pgid instead.
      await writeProfileOwnerMarker(
        profile,
        typeof owner === 'number' ? { pgid: owner, pid: owner } : owner
      );
    }
    created[name] = profile;
  }
  return { profiles: created, temp };
}

test('sweepStaleProfiles reclaims a sibling profile whose owning launcher is gone', async () => {
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-dead01': 4242,
  });

  try {
    const result = await sweepStaleProfiles({
      // The fabricated pgid must not be resolved against the host process table.
      hasLiveProcessGroupMembers: async () => false,
      isOwnerAlive: (pid) => pid !== 4242,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, [profiles['brainstrike-agent-devtools-dead01']]);
    await assert.rejects(stat(profiles['brainstrike-agent-devtools-dead01']), { code: 'ENOENT' });
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles can reclaim interrupted Windows pnpm shims without touching profiles', async () => {
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-dead01': 4242,
    'brainstrike-agent-pnpm-dead01': { pgid: null, pid: 4243, platform: 'win32' },
  });

  try {
    const result = await sweepStaleProfiles({
      isOwnerAlive: () => false,
      prefix: PNPM_SHIM_PREFIX,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, [profiles['brainstrike-agent-pnpm-dead01']]);
    await assert.rejects(stat(profiles['brainstrike-agent-pnpm-dead01']), { code: 'ENOENT' });
    await stat(profiles['brainstrike-agent-devtools-dead01']);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles preserves a shim abandoned while an unmanaged preflight may live', async () => {
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-pnpm-preflight': {
      pgid: null,
      pid: 4243,
      platform: 'win32-unmanaged-preflight',
    },
  });

  try {
    const result = await sweepStaleProfiles({
      isOwnerAlive: () => false,
      prefix: PNPM_SHIM_PREFIX,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.legacy, [profiles['brainstrike-agent-pnpm-preflight']]);
    await stat(profiles['brainstrike-agent-pnpm-preflight']);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('reportSweep uses the requested pnpm shim label and listing prefix', () => {
  const lines = [];
  reportSweep(
    {
      failed: [],
      legacy: Array.from({ length: 11 }, (_, index) => `/tmp/${PNPM_SHIM_PREFIX}${index}`),
      removed: ['/tmp/removed'],
      scanError: null,
      skippedLive: [],
    },
    (line) => lines.push(line),
    (line) => lines.push(line),
    { prefix: PNPM_SHIM_PREFIX, resourceName: 'pnpm shim' }
  );

  const report = lines.join('\n');
  assert.match(report, /reclaimed 1 abandoned pnpm shim\(s\)/);
  assert.match(report, /found 11 pnpm shim\(s\)/);
  assert.match(report, /brainstrike-agent-pnpm-\*/);
  assert.doesNotMatch(report, /brainstrike-agent-devtools-\*/);
});

test('sweepStaleProfiles never removes a concurrent session, however old it is', async () => {
  // Age alone cannot decide this: an agent-debug session is routinely left
  // running for hours. Only a live owning pid protects it.
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-live01': 4242,
  });

  try {
    const result = await sweepStaleProfiles({
      isOwnerAlive: (pid) => pid === 4242,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.skippedLive, [profiles['brainstrike-agent-devtools-live01']]);
    // Still fully intact, contents included.
    await stat(path.join(profiles['brainstrike-agent-devtools-live01'], 'profiles'));
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles never removes the profile owned by this run', async () => {
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-self01': process.pid,
  });

  try {
    const result = await sweepStaleProfiles({
      currentUserDataDir: profiles['brainstrike-agent-devtools-self01'],
      // Even if the liveness probe were wrong, our own profile is off limits.
      isOwnerAlive: () => false,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, []);
    await stat(profiles['brainstrike-agent-devtools-self01']);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles reports markerless legacy profiles instead of deleting them', async () => {
  // Profiles predating the owner marker cannot be proven stale, so the sweep
  // surfaces them for an explicit human decision rather than guessing.
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-legacy1': 'legacy',
    'brainstrike-agent-devtools-legacy2': 'legacy',
  });

  try {
    const result = await sweepStaleProfiles({
      isOwnerAlive: () => false,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.legacy.sort(), [
      profiles['brainstrike-agent-devtools-legacy1'],
      profiles['brainstrike-agent-devtools-legacy2'],
    ]);
    await stat(profiles['brainstrike-agent-devtools-legacy1']);
    await stat(profiles['brainstrike-agent-devtools-legacy2']);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles treats an unreadable marker as legacy rather than crashing', async () => {
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-broken': 4242,
  });
  await writeFile(
    path.join(profiles['brainstrike-agent-devtools-broken'], 'agent-devtools-owner.json'),
    '{ not json'
  );

  try {
    const result = await sweepStaleProfiles({
      isOwnerAlive: () => false,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.legacy, [profiles['brainstrike-agent-devtools-broken']]);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles ignores temp entries it does not own', async () => {
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-dead01': 4242,
  });
  // The E2E fixture and unrelated tooling share this directory.
  const foreign = path.join(temp, 'brainstrike-test-user-data-1-shard-0');
  await mkdir(foreign, { recursive: true });

  try {
    const result = await sweepStaleProfiles({
      // The fabricated pgid must not be resolved against the host process table.
      hasLiveProcessGroupMembers: async () => false,
      isOwnerAlive: () => false,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, [profiles['brainstrike-agent-devtools-dead01']]);
    assert.deepEqual(result.legacy, []);
    await stat(foreign);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles keeps going when one stale profile cannot be removed', async () => {
  // Opportunistic hygiene must never block the session the user asked for, but
  // the failure still has to be visible to the caller.
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-dead01': 4242,
    'brainstrike-agent-devtools-stuck1': 4243,
  });
  const stuck = profiles['brainstrike-agent-devtools-stuck1'];

  try {
    const result = await sweepStaleProfiles({
      // Both pgids are fabricated; resolving them against the host process
      // table would classify a colliding one as live and never call
      // `removeProfile` at all, which is exactly what this test is asserting on.
      hasLiveProcessGroupMembers: async () => false,
      isOwnerAlive: () => false,
      removeProfile: async (target) => {
        if (target === stuck) {
          throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
        }
        await rm(target, { force: true, recursive: true });
      },
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, [profiles['brainstrike-agent-devtools-dead01']]);
    assert.deepEqual(
      result.failed.map((entry) => entry.userDataDir),
      [stuck]
    );
    assert.equal(result.failed[0].error.code, 'EBUSY');
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles tolerates a temp directory that cannot be scanned', async () => {
  // A sweep is best-effort hygiene; an unreadable tmpdir must not stop a launch.
  const result = await sweepStaleProfiles({ tempDirectory: '/fake/missing-temp-directory' });

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.legacy, []);
  assert.ok(result.scanError);
});

test('sweepStaleProfiles spares a profile whose orphaned process tree is still running', {
  skip: process.platform === 'win32',
}, async () => {
  // The launcher spawns `pnpm dev` detached, so SIGKILLing the launcher does
  // NOT kill the tree -- it is reparented and keeps writing to the profile.
  // A dead owner pid therefore does not prove the profile is idle, and
  // removing it here would race a live PGlite cluster: the exact failure this
  // whole feature exists to prevent, initiated from the other side.
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-orphan': { pgid: orphan.pid, pid: 4242 },
  });

  try {
    const result = await sweepStaleProfiles({
      // The launcher itself really is gone.
      isOwnerAlive: (pid) => pid !== 4242,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.skippedLive, [profiles['brainstrike-agent-devtools-orphan']]);
    await stat(profiles['brainstrike-agent-devtools-orphan']);
  } finally {
    forceKillProcessGroup(orphan.pid);
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles reclaims once the orphaned process tree has exited', {
  skip: process.platform === 'win32',
}, async () => {
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-done': { pgid: orphan.pid, pid: 4242 },
  });

  try {
    forceKillProcessGroup(orphan.pid);
    await new Promise((resolve) => orphan.once('exit', resolve));

    const result = await sweepStaleProfiles({
      isOwnerAlive: (pid) => pid !== 4242,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, [profiles['brainstrike-agent-devtools-done']]);
    await assert.rejects(stat(profiles['brainstrike-agent-devtools-done']), { code: 'ENOENT' });
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles cannot prove a POSIX profile with no recorded process group', async () => {
  // Killed between mkdtemp and the post-spawn marker update: a tree may exist
  // and we have no handle on it, so removal is not provable.
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-nopgid': { pgid: null, pid: 4242, platform: 'darwin' },
  });

  try {
    const result = await sweepStaleProfiles({
      isOwnerAlive: () => false,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.legacy, [profiles['brainstrike-agent-devtools-nopgid']]);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles reclaims a Windows profile on the launcher pid alone', async () => {
  // Windows descendants inherit a non-breakaway Job Object with
  // KILL_ON_JOB_CLOSE, so the tree cannot outlive the launcher there.
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-win32': { pgid: null, pid: 4242, platform: 'win32' },
  });

  try {
    const result = await sweepStaleProfiles({
      isOwnerAlive: () => false,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, [profiles['brainstrike-agent-devtools-win32']]);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('sweepStaleProfiles reclaims a pre-boot profile despite a recycled pid', async () => {
  // After a reboot, pids are re-issued from a low watermark, so a stale marker
  // can probe as alive against an unrelated process. Without this the profile
  // becomes permanently unreclaimable and the leak never clears.
  const { temp, profiles } = await createSiblingProfiles({
    'brainstrike-agent-devtools-preboot': { pgid: 4242, pid: 4242, startedAtMs: 1000 },
  });

  try {
    const result = await sweepStaleProfiles({
      hasLiveProcessGroupMembers: async () => true,
      // Everything probes alive; only the boot boundary proves otherwise.
      isOwnerAlive: () => true,
      tempDirectory: temp,
    });

    assert.deepEqual(result.removed, [profiles['brainstrike-agent-devtools-preboot']]);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test('reportSweep makes skipped live profiles visible rather than silent', async () => {
  const lines = [];
  reportSweep(
    {
      failed: [],
      legacy: [],
      removed: [],
      scanError: null,
      skippedLive: ['/tmp/brainstrike-agent-devtools-a', '/tmp/brainstrike-agent-devtools-b'],
    },
    (line) => lines.push(line),
    (line) => lines.push(line)
  );

  assert.match(lines.join('\n'), /2 profile\(s\) still in use/);
});

test('reportSweep names legacy profiles individually instead of suggesting a wildcard', async () => {
  // A `brainstrike-agent-devtools-*` glob would also match a concurrent
  // session's profile, so the report must never hand one to the user.
  const lines = [];
  reportSweep(
    {
      failed: [],
      legacy: [
        '/tmp/brainstrike-agent-devtools-legacy1',
        '/tmp/brainstrike-agent-devtools-legacy2',
      ],
      removed: [],
      scanError: null,
      skippedLive: [],
    },
    (line) => lines.push(line),
    (line) => lines.push(line)
  );

  const report = lines.join('\n');
  assert.ok(!report.includes('*'), `report must not suggest a glob:\n${report}`);
  assert.ok(report.includes('/tmp/brainstrike-agent-devtools-legacy1'));
  assert.ok(report.includes('/tmp/brainstrike-agent-devtools-legacy2'));
});

test('reportSweep bounds a long legacy list and only ever globs for listing', async () => {
  const lines = [];
  reportSweep(
    {
      failed: [],
      legacy: Array.from(
        { length: 121 },
        (_, index) => `/tmp/brainstrike-agent-devtools-p${index}`
      ),
      removed: [],
      scanError: null,
      skippedLive: [],
    },
    (line) => lines.push(line),
    (line) => lines.push(line)
  );

  const report = lines.join('\n');
  assert.match(report, /found 121 profile\(s\)/);
  assert.match(report, /\.\.\.and 111 more/);
  // Bounded output: the header, ten paths, and the overflow note.
  assert.equal(lines.length, 12);
  // Any glob that survives must be read-only.
  for (const line of lines.filter((entry) => entry.includes('*'))) {
    assert.match(line, /ls -d/);
    assert.ok(!line.includes('rm '), `glob must never be paired with rm: ${line}`);
  }
});

test('createAgentDevtoolsProfile records an owner marker the sweep can verify', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-agent-debug-marker-test-'));

  try {
    const { userDataDir } = await createAgentDevtoolsProfile({
      platform: 'linux',
      tempDirectory: root,
    });
    const marker = await readProfileOwnerMarker(userDataDir);

    assert.equal(marker.pid, process.pid);
    assert.equal(marker.platform, process.platform);
    // No process group until the dev server is spawned.
    assert.equal(marker.pgid, null);
    assert.ok(Number.isInteger(marker.startedAtMs));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('a profile whose owner was SIGKILLed is reclaimed once its tree is gone too', {
  skip: process.platform === 'win32',
}, async () => {
  // The end-to-end case the sweep exists for: no exit handler can run, so the
  // profile survives until a later launcher proves both the launcher AND its
  // detached tree are gone.
  const temp = await mkdtemp(path.join(tmpdir(), 'brainstrike-agent-debug-sigkill-test-'));
  const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const abandoned = path.join(temp, 'brainstrike-agent-devtools-killed');
  await mkdir(abandoned, { recursive: true });
  await writeProfileOwnerMarker(abandoned, { pgid: victim.pid, pid: victim.pid });

  try {
    // Still running: not reclaimable yet, however dead the launcher looks.
    const whileLive = await sweepStaleProfiles({
      isOwnerAlive: () => false,
      tempDirectory: temp,
    });
    assert.deepEqual(whileLive.removed, []);
    assert.deepEqual(whileLive.skippedLive, [abandoned]);

    forceKillProcessGroup(victim.pid);
    await new Promise((resolve) => victim.once('exit', resolve));

    const result = await sweepStaleProfiles({ tempDirectory: temp });

    assert.deepEqual(result.removed, [abandoned]);
    await assert.rejects(stat(abandoned), { code: 'ENOENT' });
  } finally {
    forceKillProcessGroup(victim.pid);
    await rm(temp, { force: true, recursive: true });
  }
});
