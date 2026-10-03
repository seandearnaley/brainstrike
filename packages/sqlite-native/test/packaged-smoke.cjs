'use strict';

/**
 * Packaged-app proof for better-sqlite3 + sqlite-vec. Run after
 * `pnpm --filter @brainstrike/desktop run pack`.
 *
 * Loading a `.node` or `vec0` from `app.asar.unpacked` is the one thing dev-mode
 * tests cannot prove, and it must be proven in the PACKAGED executable: on macOS
 * the hardened runtime's library validation applies to the process that
 * dlopen()s `vec0.dylib`. So this driver starts the packaged executable in node
 * mode (`ELECTRON_RUN_AS_NODE=1`, as test:packaged-python does) running
 * packaged-probe.cjs, then judges the facts the probe wrote. Mirrors
 * packages/secure-fs-native/test/packaged-smoke.cjs.
 */

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { provenanceFailures } = require('./smoke-lib.cjs');

const PRODUCT = 'BrainStrike Desktop';
const LAYOUTS = {
  darwin: {
    directory: { arm64: 'mac-arm64', x64: 'mac' },
    executable: (dir) => path.join(dir, `${PRODUCT}.app`, 'Contents', 'MacOS', PRODUCT),
    resources: (dir) => path.join(dir, `${PRODUCT}.app`, 'Contents', 'Resources'),
  },
  linux: {
    directory: { arm64: 'linux-arm64-unpacked', x64: 'linux-unpacked' },
    executable: (dir) => path.join(dir, 'brainstrike-desktop'),
    resources: (dir) => path.join(dir, 'resources'),
  },
  win32: {
    directory: { arm64: 'win-arm64-unpacked', x64: 'win-unpacked' },
    executable: (dir) => path.join(dir, `${PRODUCT}.exe`),
    resources: (dir) => path.join(dir, 'resources'),
  },
};

const layout = LAYOUTS[process.platform];
const directoryName = layout?.directory[process.arch];
if (!directoryName) {
  throw new Error(`no packaged layout for ${process.platform}-${process.arch}`);
}
const releaseDirectory = path.resolve(__dirname, '../../../apps/desktop/release', directoryName);
const executable = layout.executable(releaseDirectory);
const resources = layout.resources(releaseDirectory);
for (const required of [executable, path.join(resources, 'app.asar')]) {
  if (!existsSync(required)) {
    throw new Error(`Missing packaged file (run the desktop pack first): ${required}`);
  }
}

const out = path.join(
  process.env.SMOKE_OUT_DIR || os.tmpdir(),
  `sqlite-native-smoke-packaged-${process.platform}-${process.arch}.json`
);
rmSync(out, { force: true });
const ptyOut = out.replace(/\.json$/, '-pty.json');
rmSync(ptyOut, { force: true });

const env = { ...process.env };
env.ELECTRON_RUN_AS_NODE = '1';
env.SQLITE_NATIVE_SMOKE_OUT = out;
env.SQLITE_NATIVE_PTY_OUT = ptyOut;
const run = spawnSync(executable, [path.join(__dirname, 'packaged-probe.cjs')], {
  env,
  stdio: 'inherit',
  timeout: 120_000,
});
if (run.error) {
  throw run.error;
}
if (!existsSync(out)) {
  throw new Error(`packaged probe wrote no result (exit ${run.status}, signal ${run.signal})`);
}

const facts = JSON.parse(readFileSync(out, 'utf8'));
const failures = [];
if (facts.error) {
  failures.push(`packaged probe failed to load the package:\n${facts.error}`);
} else {
  if (!facts.electron) {
    failures.push('probe did not run inside Electron');
  }
  if (realpathSync(facts.resourcesPath) !== realpathSync(resources)) {
    failures.push(`probe ran outside the packaged app: ${facts.resourcesPath} != ${resources}`);
  }
  failures.push(...provenanceFailures(facts, { packaged: true }));
}
if (run.status !== 0 && !facts.error) {
  failures.push(`probe exited ${run.status}`);
}

// npmRebuild:false is global. Reuse the existing real filesystem probes, then
// spawn a terminal from the packaged dependency, all under the packaged exe.
// Keep separate processes so SQLite's prebuild-only require.cache proof stays
// isolated from the N-API addons that are intentionally built at install time.
const addons = [];
for (const [name, probe, args = []] of [
  ['secure-fs-native', path.resolve(__dirname, '../../secure-fs-native/test/packaged-smoke.cjs')],
  ['parcel-watcher', path.resolve(__dirname, '../../file-system/test/parcel-packaged-smoke.cjs')],
  ['node-pty', path.join(__dirname, 'packaged-pty-probe.cjs')],
  ...(process.platform === 'linux'
    ? [
        [
          'python-runtime-layout',
          path.resolve(
            __dirname,
            '../../../apps/desktop/src/__tests__/fixtures/packaged-python-fence-probe.cjs'
          ),
          ['--layout-only'],
        ],
      ]
    : []),
]) {
  const result = spawnSync(executable, [probe, ...args], {
    encoding: 'utf8',
    env,
    timeout: 120_000,
  });
  const error =
    result.error?.message ??
    (result.status === 0
      ? null
      : result.stderr || `exit ${result.status}, signal ${result.signal}`);
  addons.push({ error, name, ok: error === null });
  if (error) {
    failures.push(`packaged ${name} probe failed: ${error}`);
  }
}
if (existsSync(ptyOut)) {
  const pty = JSON.parse(readFileSync(ptyOut, 'utf8'));
  addons[2].facts = pty;
  if (pty.error) {
    failures.push(`packaged node-pty probe failed: ${pty.error}`);
  }
} else {
  failures.push('packaged node-pty probe wrote no result');
}

writeFileSync(out, JSON.stringify({ addons, facts, failures, ok: failures.length === 0 }, null, 2));
process.stdout.write(`${JSON.stringify({ addons, facts, failures }, null, 2)}\n`);
if (failures.length > 0) {
  process.stderr.write(`SMOKE FAILED:\n${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('SMOKE PASSED\n');
