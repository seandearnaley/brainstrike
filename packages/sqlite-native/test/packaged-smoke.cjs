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

const env = { ...process.env };
env.ELECTRON_RUN_AS_NODE = '1';
env.SQLITE_NATIVE_SMOKE_OUT = out;
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

writeFileSync(out, JSON.stringify({ facts, failures, ok: failures.length === 0 }, null, 2));
process.stdout.write(`${JSON.stringify({ facts, failures }, null, 2)}\n`);
if (failures.length > 0) {
  process.stderr.write(`SMOKE FAILED:\n${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('SMOKE PASSED\n');
