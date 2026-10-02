'use strict';

/**
 * Shared by electron-smoke.cjs (dev Electron) and packaged-smoke.cjs /
 * packaged-probe.cjs (the packaged executable).
 *
 * collectFacts() loads the package the way the app will, then records what the
 * runtime actually did. provenanceFailures() judges those facts. The two are
 * separate so the packaged driver can judge a probe that ran in another process.
 *
 * HOW THE PACKAGE IS LOADED. Desktop's main build bundles to CJS with
 * `packages: 'external'`, and an ESM-only workspace package is inlined from
 * SOURCE by alias (see MAIN_PROCESS_BUILD_OPTIONS.alias in
 * apps/desktop/scripts/build-main-config.mjs). loadPackage() does exactly that
 * with esbuild: the package source is bundled, `better-sqlite3` and `sqlite-vec`
 * stay external `require`s, and those resolve from `requireFrom`, which is the
 * packaged `app.asar` when packaged. Node's ESM loader cannot read a
 * package.json inside an asar, so importing the package's `dist` there would
 * fail for a reason the app never hits.
 *
 * The provenance rules (from the native-index-sqlite spike):
 *   1. every `.node` in require.cache is better-sqlite3's shipped
 *      `prebuilds/<platform>-<arch>.node`;
 *   2. the OS maps exactly one better-sqlite3 `.node` and exactly one `vec0.*`
 *      into the process (lsof / /proc/<pid>/maps / Get-Process Modules), because
 *      asar paths are virtual and only a real file can be dlopen()ed;
 *   3. packaged: both come from `app.asar.unpacked`, and the packaged tree has no
 *      node-gyp output (`build/`, `config.gypi`) for better-sqlite3.
 */

const { execFileSync } = require('node:child_process');
const { mkdtempSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const esbuild = require('esbuild');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const SEP = String.raw`[\\/]`;
const VEC_OS = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
const VEC_EXT = { darwin: 'dylib', linux: 'so', win32: 'dll' }[process.platform];
const PREBUILD = new RegExp(
  `${SEP}node_modules${SEP}better-sqlite3${SEP}prebuilds${SEP}${process.platform}-${process.arch}\\.node$`,
  'i'
);
const VEC0 = new RegExp(
  `${SEP}node_modules${SEP}sqlite-vec-${VEC_OS}-${process.arch}${SEP}vec0\\.${VEC_EXT}$`,
  'i'
);
const UNPACKED = /[\\/]app\.asar\.unpacked[\\/]/i;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  );
}

/** Native files the OS has mapped into `pid`, filtered to the two we ship. */
function mappedNativeFiles(pid) {
  let files;
  if (process.platform === 'darwin') {
    files = execFileSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.startsWith('n/'))
      .map((line) => line.slice(1));
  } else if (process.platform === 'linux') {
    files = readFileSync(`/proc/${pid}/maps`, 'utf8')
      .split('\n')
      .map((line) => line.match(/\s(\/.*)$/)?.[1])
      .filter(Boolean);
  } else if (process.platform === 'win32') {
    files = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid}).Modules | ForEach-Object { $_.FileName }`,
      ],
      { encoding: 'utf8' }
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } else {
    throw new Error(`no mapped-file probe for ${process.platform}`);
  }
  return [...new Set(files)].filter(
    (file) => /better[-_]sqlite3.*\.node$/i.test(file) || /[\\/]vec0\.(dylib|so|dll)$/i.test(file)
  );
}

/** Bundles the package SOURCE to CJS; its two native deps resolve from `requireFrom`. */
function loadPackage(requireFrom) {
  const { outputFiles } = esbuild.buildSync({
    absWorkingDir: PACKAGE_ROOT,
    bundle: true,
    entryPoints: ['src/index.ts'],
    format: 'cjs',
    packages: 'external',
    platform: 'node',
    target: 'node24',
    tsconfigRaw: '{}',
    write: false,
  });
  const module = { exports: {} };
  vm.runInThisContext(`(function (require, module, exports) {${outputFiles[0].text}\n})`, {
    filename: path.join(PACKAGE_ROOT, 'sqlite-native.bundle.cjs'),
  })(requireFrom, module, module.exports);
  return module.exports;
}

const float32 = (values) => Buffer.from(new Float32Array(values).buffer);

/** Loads the package, exercises it, and reports what loaded. */
function collectFacts(requireFrom) {
  const { openConnection, sqliteVecExtensionPath } = loadPackage(requireFrom);
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'sqlite-native-smoke-'));
  try {
    const db = openConnection(path.join(workDir, 'smoke.db'));
    try {
      const vecVersion = db.prepare('select vec_version()').pluck().get();
      db.exec('create virtual table smoke using vec0(id integer primary key, embedding float[4])');
      const insert = db.prepare('insert into smoke(id, embedding) values (?, ?)');
      insert.run(1n, float32([1, 0, 0, 0]));
      insert.run(2n, float32([0, 1, 0, 0]));
      const nearestId = db
        .prepare('select id from smoke where embedding match ? and k = 1')
        .pluck()
        .get(float32([0.9, 0.1, 0, 0]));
      // Before close(): SQLite dlcloses the extension with the connection.
      return {
        electron: process.versions.electron ?? null,
        extensionPath: sqliteVecExtensionPath(),
        mappedNativeFiles: mappedNativeFiles(process.pid),
        nearestId,
        node: process.versions.node,
        platform: `${process.platform}-${process.arch}`,
        requireCacheNodes: Object.keys(require.cache).filter((file) => file.endsWith('.node')),
        vecVersion,
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
}

/**
 * The shipped tree: natives under `app.asar.unpacked`, and any node-gyp output
 * for better-sqlite3 in either view of the package (the asar and the unpacked
 * directory). Must run where the asar is readable, i.e. inside the packaged exe.
 */
function packagedTreeFacts(resources, requireFrom) {
  const unpacked = path.join(resources, 'app.asar.unpacked');
  const betterSqlite3Dirs = [
    path.dirname(requireFrom.resolve('better-sqlite3/package.json')),
    path.join(unpacked, 'node_modules', 'better-sqlite3'),
  ];
  return {
    gypOutput: betterSqlite3Dirs.flatMap((dir) =>
      walk(dir).filter(
        (file) => file.endsWith('config.gypi') || /[\\/]build[\\/]/.test(path.relative(dir, file))
      )
    ),
    // Only the two packages this package ships; the tree holds other addons too.
    natives: walk(unpacked).filter(
      (file) =>
        /\.(node|dylib|so|dll)$/i.test(file) &&
        /[\\/]node_modules[\\/](better-sqlite3|sqlite-vec-[^\\/]+)[\\/]/i.test(file)
    ),
    unpacked,
  };
}

function behaviorFailures(facts) {
  const failures = [];
  if (!/^v\d+\.\d+\.\d+/.test(String(facts.vecVersion))) {
    failures.push(`select vec_version() did not return a version: ${facts.vecVersion}`);
  }
  if (facts.nearestId !== 1) {
    failures.push(`vec0 round trip returned id ${facts.nearestId}, expected 1`);
  }
  return failures;
}

function requireCacheFailures(facts) {
  if (facts.requireCacheNodes.length === 0) {
    return ['no .node file recorded in require.cache'];
  }
  return facts.requireCacheNodes
    .filter((file) => !PREBUILD.test(file))
    .map((file) => `require.cache .node is not the ${facts.platform} prebuild: ${file}`);
}

function extensionPathFailures(facts, packaged) {
  const failures = [];
  if (!VEC0.test(facts.extensionPath)) {
    failures.push(
      `extension path is not sqlite-vec-${VEC_OS}-${process.arch}/vec0.${VEC_EXT}: ${facts.extensionPath}`
    );
  }
  if (packaged && !UNPACKED.test(facts.extensionPath)) {
    failures.push(
      `packaged sqlite-vec extension not loaded from app.asar.unpacked: ${facts.extensionPath}`
    );
  }
  if (!packaged && UNPACKED.test(facts.extensionPath)) {
    failures.push(`dev run loaded an unpacked path: ${facts.extensionPath}`);
  }
  return failures;
}

function mappedFailures(facts, packaged) {
  const failures = [];
  const mappedNode = facts.mappedNativeFiles.filter((file) => file.toLowerCase().endsWith('.node'));
  const mappedVec = facts.mappedNativeFiles.filter((file) => VEC0.test(file));
  if (mappedNode.length !== 1) {
    failures.push(
      `expected exactly one mapped better-sqlite3 .node, got ${JSON.stringify(mappedNode)}`
    );
  }
  if (mappedVec.length !== 1) {
    failures.push(`expected exactly one mapped vec0.${VEC_EXT}, got ${JSON.stringify(mappedVec)}`);
  }
  for (const file of mappedNode.filter((candidate) => !PREBUILD.test(candidate))) {
    failures.push(`mapped .node is not the prebuild: ${file}`);
  }
  if (packaged) {
    for (const file of facts.mappedNativeFiles.filter((candidate) => !UNPACKED.test(candidate))) {
      failures.push(`mapped native not from app.asar.unpacked: ${file}`);
    }
  }
  return failures;
}

function packagedTreeFailures({ tree }) {
  const failures = tree.gypOutput.map(
    (file) => `node-gyp output in packaged better-sqlite3: ${file}`
  );
  if (tree.natives.filter((file) => PREBUILD.test(file)).length !== 1) {
    failures.push(`app.asar.unpacked lacks the host better-sqlite3 prebuild: ${tree.unpacked}`);
  }
  if (tree.natives.filter((file) => VEC0.test(file)).length !== 1) {
    failures.push(`app.asar.unpacked lacks vec0.${VEC_EXT}: ${tree.unpacked}`);
  }
  return failures;
}

/** Everything that violates the provenance rules; empty when the run is clean. */
function provenanceFailures(facts, { packaged }) {
  return [
    ...behaviorFailures(facts),
    ...requireCacheFailures(facts),
    ...extensionPathFailures(facts, packaged),
    ...mappedFailures(facts, packaged),
    ...(packaged ? packagedTreeFailures(facts) : []),
  ];
}

module.exports = { collectFacts, packagedTreeFacts, provenanceFailures };
