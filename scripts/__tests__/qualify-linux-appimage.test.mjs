import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { shutdownChildProcessTree } from '../../apps/desktop/scripts/start-agent-devtools-session.mjs';
import {
  buildAppImageLaunch,
  main,
  parseAppImageQualificationArgs,
  requireDisplay,
} from '../qualify-linux-appimage.mjs';
import {
  inspectArtifact,
  inspectDesktopEntry,
  requireUserNamespaces,
  validateAppImageHeader,
} from '../qualify-linux-appimage-artifact.mjs';
import {
  assertEncryptedCredential,
  inspectProfile,
  inspectSandboxArguments,
  runLifecycleStages,
  stopAppImageProcess,
  waitForDebugEndpoint,
} from '../qualify-linux-appimage-lifecycle.mjs';

test('qualification requires two explicit artifacts and an explicit launch mode', () => {
  const input = [
    '--previous',
    '/tmp/old.AppImage',
    '--candidate',
    '/tmp/new.AppImage',
    '--mode',
    'mounted',
    '--output',
    '/tmp/result.json',
  ];
  assert.deepEqual(parseAppImageQualificationArgs(input), {
    candidate: '/tmp/new.AppImage',
    mode: 'mounted',
    output: '/tmp/result.json',
    previous: '/tmp/old.AppImage',
  });
  for (const invalid of [
    [],
    input.slice(0, 4),
    [...input, '--no-sandbox'],
    [...input, '--mode', 'extract'],
    input.map((item) => (item === 'mounted' ? 'automatic' : item)),
    input.map((item) => (item === '/tmp/old.AppImage' ? 'relative.AppImage' : item)),
    input.map((item) => (item === '/tmp/new.AppImage' ? '/tmp/old.AppImage' : item)),
  ]) {
    assert.throws(() => parseAppImageQualificationArgs(invalid));
  }
});

test('only an actual x64 type-2 AppImage is accepted, not an unpacked executable', () => {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.set([0x41, 0x49, 2], 8);
  header.writeUInt16LE(62, 18);
  assert.doesNotThrow(() => validateAppImageHeader(header));
  for (const [offset, value] of [
    [0, 0],
    [4, 1],
    [5, 2],
    [8, 0],
    [10, 1],
    [18, 183],
  ]) {
    const invalid = Buffer.from(header);
    invalid[offset] = value;
    assert.throws(() => validateAppImageHeader(invalid));
  }
  assert.throws(() => validateAppImageHeader(Buffer.alloc(2)));
});

test('launch preserves security and isolates all writable profile paths', () => {
  const base = {
    artifact: '/tmp/candidate.AppImage',
    inherited: {
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/test',
      DISPLAY: ':1',
      ELECTRON_DISABLE_SANDBOX: '1',
      HOME: '/home/real-user',
      NODE_OPTIONS: '--require malicious.js',
      OPENAI_API_KEY: 'must-not-inherit',
    },
    port: 9237,
    root: '/tmp/appimage-qa-unique',
  };
  const mounted = buildAppImageLaunch({ ...base, mode: 'mounted' });
  assert.equal(mounted.command, base.artifact);
  assert.ok(!mounted.args.some((arg) => /no-sandbox|disable.*sandbox/.test(arg)));
  assert.equal(mounted.env.HOME, `${base.root}/home`);
  assert.equal(mounted.env.XDG_CONFIG_HOME, `${base.root}/config`);
  assert.equal(mounted.env.XDG_DATA_HOME, `${base.root}/data`);
  assert.equal(mounted.env.BRAINSTRIKE_E2E_USER_DATA_DIR, `${base.root}/profile`);
  assert.equal(mounted.env.BRAINSTRIKE_DB_ROOT_PATH, `${base.root}/database`);
  assert.equal(mounted.env.BRAINSTRIKE_DB_PROFILE, 'appimage-qualification');
  assert.equal(mounted.env.OPENAI_API_KEY, undefined);
  assert.equal(mounted.env.NODE_OPTIONS, undefined);
  assert.equal(mounted.env.ELECTRON_DISABLE_SANDBOX, undefined);
  assert.equal(mounted.env.ELECTRON_IS_E2E_TEST, undefined);
  assert.equal(mounted.env.DBUS_SESSION_BUS_ADDRESS, base.inherited.DBUS_SESSION_BUS_ADDRESS);
  assert.equal(mounted.env.BRAINSTRIKE_AGENT_DEVTOOLS_HOST, '127.0.0.1');
  assert.equal(mounted.env.BRAINSTRIKE_AGENT_DEVTOOLS_PORT, '9237');
  const extracted = buildAppImageLaunch({ ...base, mode: 'extract' });
  assert.equal(extracted.args[0], '--appimage-extract-and-run');
  assert.ok(!mounted.args.includes('--appimage-extract-and-run'));
});

test('only the first launch seeds state; restart and candidate must preserve it', async () => {
  const calls = [];
  const report = { checks: [] };
  await runLifecycleStages({
    candidate: 'new',
    launch: async (artifact) => ({
      check: async (seed) => {
        calls.push([artifact, seed]);
        return { preserved: true };
      },
      close: async () => calls.push([artifact, 'close']),
    }),
    previous: 'old',
    report,
  });
  assert.deepEqual(calls, [
    ['old', true],
    ['old', 'close'],
    ['old', false],
    ['old', 'close'],
    ['new', false],
    ['new', 'close'],
    ['new', false],
    ['new', 'close'],
  ]);
  assert.equal(report.checks.length, 4);
});

test('a preservation failure closes the app and stops before later launches', async () => {
  let launches = 0;
  let closes = 0;
  const report = { checks: [] };
  await assert.rejects(
    runLifecycleStages({
      candidate: 'new',
      launch: async () => {
        launches += 1;
        return {
          check: async (seed) => {
            if (!seed) {
              throw new Error('lost state');
            }
          },
          close: async () => {
            closes += 1;
          },
        };
      },
      previous: 'old',
      report,
    }),
    /lost state/
  );
  assert.equal(launches, 2);
  assert.equal(closes, 2);
  assert.equal(report.checks.length, 1);
});

function makeHeader() {
  const header = Buffer.alloc(65);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.set([0x41, 0x49, 2], 8);
  header.writeUInt16LE(62, 18);
  return header;
}

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'appimage-contract-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

function qualificationArgs(root) {
  return [
    '--previous',
    path.join(root, 'previous.AppImage'),
    '--candidate',
    path.join(root, 'candidate.AppImage'),
    '--mode',
    'extract',
    '--output',
    path.join(root, 'report.json'),
  ];
}

function successfulDependencies() {
  return {
    inspectArtifact: async (filename) => ({ bytes: 100, path: filename, sha256: filename }),
    inspectMetadata: async () => ({ desktop: { version: '0.1.0' } }),
    qualifyLifecycle: async ({ report }) => {
      for (const name of [
        'first-launch',
        'previous-restart',
        'replacement-launch',
        'candidate-restart',
        'encrypted-at-rest',
      ]) {
        report.checks.push({ name, status: 'passed' });
      }
    },
    requireDisplay: () => {},
    requireHost: async () => {},
    requireUserNamespaces: async () => {},
  };
}

test('artifact inspection rejects non-executables, directories, short files and resolves aliases', async (t) => {
  const root = await temporary(t);
  const filename = path.join(root, 'real image.AppImage');
  const header = makeHeader();
  await writeFile(filename, header, { mode: 0o700 });
  const inspected = await inspectArtifact(filename);
  assert.equal(inspected.bytes, 65);
  assert.match(inspected.sha256, /^[a-f0-9]{64}$/u);
  const alias = path.join(root, 'alias.AppImage');
  await symlink(filename, alias);
  assert.deepEqual(await inspectArtifact(alias), inspected);
  await chmod(filename, 0o600);
  await assert.rejects(inspectArtifact(filename), /executable regular file/);
  await assert.rejects(inspectArtifact(root), /executable regular file/);
  await chmod(filename, 0o700);
  await writeFile(filename, header.subarray(0, 20));
  await assert.rejects(inspectArtifact(filename), /type-2 AppImage/);
});

test('desktop metadata records versions and refuses to disguise sandbox-bypass launchers', () => {
  const source =
    '[Desktop Entry]\nName=BrainStrike Desktop\nExec=AppRun %U\nIcon=brainstrike-desktop\nX-AppImage-Version=0.1.0\n';
  assert.equal(inspectDesktopEntry(source).version, '0.1.0');
  assert.equal(inspectDesktopEntry(source).disablesSandbox, false);
  assert.equal(
    inspectDesktopEntry(source.replace('AppRun %U', 'AppRun --no-sandbox %U')).disablesSandbox,
    true
  );
  assert.throws(
    () => inspectDesktopEntry(source.replace('X-AppImage-Version=0.1.0', '')),
    /metadata/
  );
});

test('missing namespace capability fails before running the AppImage', async () => {
  await assert.rejects(
    requireUserNamespaces({ env: { PATH: '/nonexistent' } }),
    /No app launch was attempted/
  );
});

test('failed process spawn is detected without waiting for the readiness deadline', async () => {
  await assert.rejects(
    waitForDebugEndpoint({ exitCode: null, signalCode: null }, 65_534, {
      spawnError: () => new Error('ENOENT'),
      timeoutMs: 5,
    }),
    /could not be started/
  );
});

test('main refuses an existing output before inspecting artifacts and preserves it', async (t) => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'report.json'), 'prior report');
  let inspected = false;
  await assert.rejects(
    main(qualificationArgs(root), {
      inspectArtifact: () => {
        inspected = true;
      },
    }),
    /EEXIST/
  );
  assert.equal(inspected, false);
  assert.equal(await readFile(path.join(root, 'report.json'), 'utf8'), 'prior report');
});

test('main fails closed for duplicate bytes and never starts the lifecycle', async (t) => {
  const root = await temporary(t);
  let launched = false;
  const report = await main(qualificationArgs(root), {
    ...successfulDependencies(),
    inspectArtifact: async (filename) => ({ path: filename, sha256: 'same' }),
    qualifyLifecycle: async () => {
      launched = true;
    },
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.failure.phase, 'artifact-identity');
  assert.equal(launched, false);
  assert.equal(JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8')).status, 'failed');
});

test('lifecycle failure stays failed and disposes its profile', async (t) => {
  const root = await temporary(t);
  const report = await main(qualificationArgs(root), {
    ...successfulDependencies(),
    qualifyLifecycle: async () => {
      throw new Error('lost state');
    },
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.failure.phase, 'lifecycle');
  assert.deepEqual(await readdir(root), ['report.json']);
});

test('report-write failure does not skip disposable profile cleanup', async (t) => {
  const root = await temporary(t);
  await assert.rejects(
    main(qualificationArgs(root), {
      ...successfulDependencies(),
      writeReport: async () => {
        throw new Error('disk failed');
      },
    }),
    /disk failed/
  );
  assert.deepEqual(await readdir(root), ['report.json']);
  assert.equal(
    JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8')).status,
    'incomplete'
  );
});

test('profile cleanup failure cannot produce a passing report', async (t) => {
  const root = await temporary(t);
  const report = await main(qualificationArgs(root), {
    ...successfulDependencies(),
    removeProfile: async () => {
      throw new Error('permission denied');
    },
  });
  assert.equal(report.status, 'failed');
  assert.match(report.cleanupFailure, /cleanup failed/);
});

test('unconfirmed process cleanup retains its profile rather than deleting live data', async (t) => {
  const root = await temporary(t);
  const report = await main(qualificationArgs(root), {
    ...successfulDependencies(),
    qualifyLifecycle: async ({ report: target }) => {
      target.profileCleanupAllowed = false;
      throw new Error('process still running');
    },
  });
  assert.equal(report.status, 'failed');
  assert.ok((await readdir(root)).some((name) => name.startsWith('appimage-qa-')));
  t.after(() => rm(report.retainedTemporaryAlias, { force: true, recursive: true }));
});

test('bounded success leaves manual clean-desktop and database gates visibly open', async (t) => {
  const root = await temporary(t);
  const report = await main(qualificationArgs(root), successfulDependencies());
  assert.equal(report.status, 'passed-bounded-lifecycle');
  assert.match(report.cleanDesktopQualification, /^not-established/u);
  assert.match(report.folderPicker, /manual/u);
  assert.equal(report.upgradeCoverage, 'artifact-replacement-only');
  assert.match(report.databaseMigration, /^not-tested/u);
  assert.deepEqual(await readdir(root), ['report.json']);
});

test('production bridge contract requires methods and reuses rather than reseeds saved state', async () => {
  const previousApi = globalThis.electronAPI;
  const previousSecrets = globalThis.secrets;
  const data = new Map();
  const keys = new Map();
  let writes = 0;
  let disposed = 0;
  globalThis.electronAPI = {
    getUserDataPath: async () => '/qa/database/profiles/appimage-qualification/pgdata',
    storage: {
      getItem: async (key) => data.get(key) ?? null,
      setItem: async (key, value) => {
        writes++;
        data.set(key, value);
      },
    },
  };
  globalThis.secrets = {
    getKey: async (key) => keys.get(key) ?? null,
    saveKey: async (key, value) => {
      writes++;
      keys.set(key, value);
      return true;
    },
  };
  const page = {
    evaluateHandle: async (callback, args) => {
      const result = callback(args);
      return {
        dispose: async () => {
          disposed++;
        },
        evaluate: (fn) => fn(result),
      };
    },
  };
  try {
    await inspectProfile(page, { marker: 'synthetic', root: '/qa', seed: true });
    await inspectProfile(page, { marker: 'synthetic', root: '/qa', seed: false });
    assert.equal(writes, 2);
    assert.equal(disposed, 2);
    data.clear();
    globalThis.secrets = {
      getKey: async () => null,
      saveKey: async () => ({ error: 'encryption_unavailable', ok: false }),
    };
    await assert.rejects(
      inspectProfile(page, { marker: 'synthetic', root: '/qa', seed: true }),
      /supported OS keyring/
    );
    globalThis.secrets.getKey = async () => {
      throw new Error('synthetic-private-detail');
    };
    await assert.rejects(
      inspectProfile(page, { marker: 'synthetic', root: '/qa', seed: false }),
      /Production profile bridge operation failed/
    );
    globalThis.secrets = {};
    await assert.rejects(
      inspectProfile(page, { marker: 'synthetic', root: '/qa', seed: false }),
      /Production storage and secrets bridges/
    );
  } finally {
    globalThis.electronAPI = previousApi;
    globalThis.secrets = previousSecrets;
  }
});

test('release AppImage desktop entries explicitly override builder sandbox bypass defaults', async () => {
  const config = JSON.parse(
    await readFile(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8')
  );
  assert.deepEqual(config.build.appImage.executableArgs, []);
});

test('an incomplete lifecycle can never produce a passing report', async (t) => {
  const root = await temporary(t);
  const report = await main(qualificationArgs(root), {
    ...successfulDependencies(),
    qualifyLifecycle: async () => {},
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.failure.phase, 'lifecycle');
});

test('artifact mutation during qualification invalidates the claimed hashes', async (t) => {
  const root = await temporary(t);
  let reads = 0;
  const report = await main(qualificationArgs(root), {
    ...successfulDependencies(),
    inspectArtifact: async (filename) => ({
      bytes: 100,
      path: filename,
      sha256: `${filename}-${++reads}`,
    }),
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.failure.phase, 'artifact-stability');
});

test('lifecycle retains both the preservation error and shutdown error', async () => {
  await assert.rejects(
    runLifecycleStages({
      candidate: 'new',
      launch: async () => ({
        check: async () => {
          throw new Error('state lost');
        },
        close: async () => {
          throw new Error('close failed');
        },
      }),
      previous: 'old',
      report: { checks: [] },
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.map((part) => part.message).join(',') === 'state lost,close failed'
  );
});

test('no display session is an actionable prelaunch failure', () => {
  assert.throws(() => requireDisplay({}), /desktop display session/);
  assert.doesNotThrow(() => requireDisplay({ DISPLAY: ':1' }));
  assert.doesNotThrow(() => requireDisplay({ WAYLAND_DISPLAY: 'wayland-0' }));
});

test('live sandbox check proves CDP process ownership and rejects injected bypass flags', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Linux /proc ownership contract');
    return;
  }
  for (const flag of ['', '--no-sandbox', '--disable-setuid-sandbox']) {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', '--', ...(flag ? [flag] : [])],
      { detached: true, stdio: 'ignore' }
    );
    await once(child, 'spawn');
    let detached = 0;
    const browser = {
      newBrowserCDPSession: async () => ({
        detach: async () => {
          detached++;
        },
        send: async () => ({ processInfo: [{ id: child.pid, type: 'browser' }] }),
      }),
    };
    try {
      if (flag) {
        await assert.rejects(
          inspectSandboxArguments(browser, child),
          /disabled Chromium sandboxing/
        );
      } else {
        assert.deepEqual(await inspectSandboxArguments(browser, child), {
          mainProcessId: child.pid,
          sandboxBypassArguments: false,
        });
      }
      await assert.rejects(
        inspectSandboxArguments(browser, { pid: child.pid + 1 }),
        /does not belong/
      );
      assert.equal(detached, 2);
    } finally {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
  }
});

test('credential-at-rest check rejects raw and base64-encoded plaintext', () => {
  const marker = 'synthetic-test-value';
  const wrap = (value) => JSON.stringify({ secrets: { 'appimage-qualification': value } });
  assert.throws(() => assertEncryptedCredential(wrap(marker), marker), /plaintext/);
  assert.throws(
    () => assertEncryptedCredential(wrap(Buffer.from(marker).toString('base64')), marker),
    /plaintext/
  );
  assert.throws(() => assertEncryptedCredential('{}', marker));
  assert.throws(() => assertEncryptedCredential(wrap('not base64!'), marker));
  assert.doesNotThrow(() =>
    assertEncryptedCredential(wrap(Buffer.from([1, 2, 3, 255]).toString('base64')), marker)
  );
});

test('long report paths use short socket paths backed by the same isolated disk directory', async (t) => {
  const base = await temporary(t);
  const root = path.join(base, 'long-qualified-artifact-output-'.repeat(3));
  let socketTemp;
  const dependencies = successfulDependencies();
  const report = await main(qualificationArgs(root), {
    ...dependencies,
    qualifyLifecycle: async (input) => {
      socketTemp = input.buildLaunch({
        artifact: '/tmp/test.AppImage',
        inherited: {},
        mode: 'extract',
        port: 9222,
        root: input.root,
      }).env.TMPDIR;
      assert.ok(
        Buffer.byteLength(socketTemp) < 60,
        'Chromium singleton sockets need a short TMPDIR'
      );
      assert.equal(await realpath(socketTemp), path.join(input.root, 'tmp'));
      await dependencies.qualifyLifecycle(input);
    },
  });
  assert.equal(report.status, 'passed-bounded-lifecycle');
  await assert.rejects(realpath(socketTemp), /ENOENT/);
});

test('graceful shutdown signals Electron main without killing the AppImage wrapper', async (t) => {
  const mainCode =
    "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000);";
  const wrapperCode = `const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => process.exit(23));
    const main = spawn(process.execPath, ['-e', ${JSON.stringify(mainCode)}], {stdio:['ignore','pipe','ignore']});
    main.stdout.once('data', () => process.stdout.write(String(main.pid)));
    main.once('exit', code => process.exit(code ?? 24));`;
  const wrapper = spawn(process.execPath, ['-e', wrapperCode], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => shutdownChildProcessTree(wrapper, 'linux'));
  const [data] = await once(wrapper.stdout, 'data');
  const mainProcessId = Number(data.toString());
  await stopAppImageProcess(wrapper, {}, { mainProcessId });
  assert.equal(wrapper.exitCode, 0);
});

test('durable failure reports retain primary and teardown causes without synthetic credentials', async (t) => {
  const root = await temporary(t);
  const report = await main(qualificationArgs(root), {
    ...successfulDependencies(),
    qualifyLifecycle: async () => {
      throw new AggregateError(
        [new Error('lost synthetic-appimage-qa-aabbcc-1234'), new Error('teardown failed')],
        'session failed'
      );
    },
  });
  assert.equal(report.status, 'failed');
  const durable = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
  assert.deepEqual(
    durable.failure.causes.map((cause) => cause.message),
    ['lost [synthetic credential]', 'teardown failed']
  );
  assert.ok(!JSON.stringify(durable).includes('synthetic-appimage-qa-aabbcc-1234'));
});
