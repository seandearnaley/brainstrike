import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import agentDevToolsDefaults from '../../agent-devtools-defaults.json' with { type: 'json' };
import {
  cleanupChildAndProfile,
  createAgentDevtoolsProfile,
  createMacAgentDebugElectronDist,
  formatMcpConfig,
  initializeWindowsJob,
  parsePort,
  removeUserDataDir,
  resolveEndpoint,
  resolvePnpmSpawnOptions,
  rewriteMacAgentDebugInfoPlist,
  shutdownChildProcessTree,
  signalProcessGroup,
  waitForEndpoint,
  waitForEndpointOrChildExit,
} from '../start-agent-devtools-session.mjs';

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
