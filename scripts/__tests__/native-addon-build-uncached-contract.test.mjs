import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { staticImportSpecifiers } from '../verify-no-source-cycles.mjs';

/**
 * Guards the "a native addon's turbo `build` output is NEVER restored from a
 * cross-environment cache" contract.
 *
 * WHY: a compiled native `.node` is architecture- and Node/OS-ABI-specific,
 * but turbo's cache hash includes NONE of that — it hashes the C/C++/JS
 * SOURCE, never the compiled artifact or the ABI it was built against. That is
 * exactly the reasoning the `test` task in packages/secure-fs-native/turbo.json
 * already spells out to justify its own `cache: false`; the `build` task
 * produces the same binary and needs the same treatment.
 *
 * The remote turbo cache (TURBO_TOKEN/TURBO_TEAM) is ONE arch-blind entry per
 * task hash, shared across every runner. CI now runs some lanes on arm64
 * (Static, Unit — Series C R9b) and others on x64 (Build, Coverage, Native
 * Electron). With a cacheable `build`, an arm64 lane and an x64 lane share a
 * single `@brainstrike/secure-fs-native#build` cache entry and overwrite each
 * other's binary — last writer wins, and the other architecture then restores
 * a `.node` it cannot dlopen.
 *
 * That is precisely what silently broke the advisory Coverage lane on
 * 2026-07-18: the x64 Coverage job built the correct x64 addon during
 * `pnpm install`, then its `pnpm turbo run build` step got a cache HIT on the
 * shared entry (last written by an arm64 lane) and restored an incompatible
 * `build/**` over the good binary, so every apps/desktop test importing
 * @brainstrike/secure-fs-native failed at import. The Unit lane never hit this:
 * it runs on arm64 (so the install-built binary already matches its arch) and
 * has no standalone `turbo run build` step to trigger the cross-arch restore.
 *
 * INVARIANT: every workspace package that compiles a native addon
 * (`gypfile: true`, or a `build` script that runs node-gyp) MUST mark its turbo
 * `build` task `cache: false`, so the addon is always compiled fresh for the
 * runner that will load it. Do NOT re-enable caching to "speed up" the build:
 * node-gyp takes a few seconds, and a wrong-arch cache hit costs an entire red
 * lane that reproduces only on the arch that lost the last write.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Minimal JSONC reader: strips `//` and block comments and trailing commas.
 * Trailing-comma removal is done inside the string-aware scan (when a `}`/`]`
 * closes outside a string, drop the comma that precedes it) rather than as a
 * regex over the whole output, so a string value containing `,]`/`,}` is never
 * corrupted.
 */
function stripJsonc(source) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      // Drop a trailing comma preceding this closer (JSONC allows it). Only
      // runs outside strings, so string contents are never touched.
      let end = out.length;
      while (end > 0 && /\s/.test(out[end - 1])) {
        end -= 1;
      }
      if (end > 0 && out[end - 1] === ',') {
        out = out.slice(0, end - 1) + out.slice(end);
      }
    }
    out += ch;
  }
  return out;
}

function readJsonc(filePath) {
  return JSON.parse(stripJsonc(readFileSync(filePath, 'utf8')));
}

/**
 * Workspace roots, derived from pnpm-workspace.yaml's `packages:` globs rather
 * than hard-coded, so a native addon added under ANY workspace root (today:
 * apps/*, packages/*, packages/config/*) is still discovered — the guard's
 * "every workspace package" claim cannot silently drift from the real globs.
 * Only the single-level `<prefix>/*` glob shape the repo uses is supported;
 * anything else throws loudly rather than being silently skipped.
 */
function workspaceGlobPrefixes() {
  const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const prefixes = [];
  let inPackages = false;
  for (const rawLine of yaml.split('\n')) {
    if (/^packages:\s*$/.test(rawLine)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = rawLine.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*$/);
      if (item) {
        const glob = item[1];
        assert.match(
          glob,
          /\/\*$/,
          `pnpm-workspace.yaml package glob "${glob}" is not the "<prefix>/*" shape this guard understands — teach workspaceGlobPrefixes() the new shape instead of letting native packages under it escape the contract.`
        );
        prefixes.push(glob.slice(0, -2));
        continue;
      }
      if (!/^\s/.test(rawLine) && rawLine.trim() !== '') {
        break; // left the `packages:` block
      }
    }
  }
  return prefixes;
}

/** Every workspace package directory, across every workspace root. */
function workspacePackageDirs() {
  const dirs = [];
  for (const prefix of workspaceGlobPrefixes()) {
    const base = path.join(repoRoot, prefix);
    if (!existsSync(base)) {
      continue;
    }
    for (const name of readdirSync(base)) {
      if (existsSync(path.join(base, name, 'package.json'))) {
        dirs.push(path.join(base, name));
      }
    }
  }
  return dirs;
}

/** Workspace packages that compile a native addon, across every workspace root. */
function nativeAddonPackageDirs() {
  return workspacePackageDirs().filter((dir) => {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const buildScript = pkg.scripts?.build ?? '';
    return pkg.gypfile === true || /node-gyp\s+(rebuild|build)/.test(buildScript);
  });
}

test('the native-addon guard has something to guard (fails vacuously otherwise)', () => {
  const dirs = nativeAddonPackageDirs();
  assert.ok(
    dirs.length > 0,
    'Expected at least one gypfile / node-gyp workspace package (e.g. @brainstrike/secure-fs-native). ' +
      'If every native addon has been removed, delete this contract test rather than let it pass vacuously.'
  );
});

/**
 * Turbo-scheduled test-family tasks (root turbo.jsonc). Scripts outside this
 * set (e.g. test:electron, test:packaged) are invoked directly by workflows in
 * their own sequential steps, so they may build inline without racing turbo.
 */
const TURBO_TEST_TASKS = ['test', 'test:integration', 'test:coverage'];

/** Root task defaults, so effective cacheability can be resolved per lane. */
const rootTurbo = readJsonc(path.join(repoRoot, 'turbo.jsonc'));

for (const dir of nativeAddonPackageDirs()) {
  const rel = path.relative(repoRoot, dir).split(path.sep).join('/');
  test(`${rel}: turbo build task is cache:false (native addon output is arch/ABI-specific)`, () => {
    const turboPath = path.join(dir, 'turbo.json');
    assert.ok(
      existsSync(turboPath),
      `${rel} compiles a native addon but has no turbo.json — it must define a tasks.build override with cache:false.`
    );
    const turbo = readJsonc(turboPath);
    const build = turbo.tasks?.build;
    assert.ok(
      build,
      `${rel}/turbo.json must define a tasks.build override so it can set cache:false on the native build.`
    );
    assert.equal(
      build.cache,
      false,
      `${rel} compiles a native addon, so its turbo build task MUST be cache:false. ` +
        'A cacheable native build shares one arch-blind remote cache entry across arm64 and x64 lanes; ' +
        'restoring the wrong architecture over the runner-correct binary is what broke the Coverage lane on 2026-07-18.'
    );
  });

  test(`${rel}: turbo test lanes take the addon from a dependsOn build edge, never an inline rebuild`, () => {
    // `node-gyp rebuild` = clean + configure + build in the package dir, and it
    // is not safe to run twice concurrently in that dir. The root `test` task
    // dependsOn ["topo"] (no build edge), so a package whose test SCRIPT also
    // runs its build inline hands turbo two concurrent rebuilds of the same
    // addon in one `turbo build ... test` invocation — they race ("make: No
    // targets specified and no makefile found" / missing .deps; reproduced
    // 2026-07-19). The sound shape is the B4 exception pattern (see
    // packages/utils/turbo.json): the script only RUNS tests, and the package
    // turbo.json appends its own `build` edge via
    // `dependsOn: ["$TURBO_EXTENDS$", "build"]` so turbo serializes the build.
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const turboPath = path.join(dir, 'turbo.json');
    const turbo = existsSync(turboPath) ? readJsonc(turboPath) : { tasks: {} };
    for (const task of TURBO_TEST_TASKS) {
      const script = pkg.scripts?.[task];
      if (!script) {
        continue;
      }
      assert.ok(
        !/node-gyp|pnpm (run )?build/.test(script),
        `${rel} scripts["${task}"] runs the native build inline ("${script}"). Turbo also schedules this package's ` +
          'build task, so a single `turbo build ... ' +
          task +
          '` run executes two concurrent node-gyp rebuilds in the same directory and they race. ' +
          'Drop the inline build and declare `dependsOn: ["$TURBO_EXTENDS$", "build"]` on the task in the package turbo.json instead.'
      );
      const dependsOn = turbo.tasks?.[task]?.dependsOn ?? [];
      assert.ok(
        dependsOn.includes('build'),
        `${rel}/turbo.json tasks["${task}"].dependsOn must include "build": the ${task} script loads the compiled ` +
          'addon but no longer builds it inline, so without the edge turbo may run the lane before (or concurrently ' +
          'with) the native build. Use ["$TURBO_EXTENDS$", "build"] to append without dropping the inherited topo cascade.'
      );

      // A lane that dlopens the addon must never replay from cache: a hit
      // reports green WITHOUT proving the binary loads on THIS machine/ABI,
      // which is the whole point of a native-addon test. `build` being
      // cache:false does not cover this — it guarantees a fresh binary, not
      // that anything loaded it. Effective cacheability = package override,
      // else the root task's value, else turbo's default (true).
      const rootTask = rootTurbo.tasks?.[task];
      const effectiveCache = turbo.tasks?.[task]?.cache ?? rootTask?.cache ?? true;
      assert.equal(
        effectiveCache,
        false,
        `${rel} lane "${task}" runs the native suite, so it must be cache:false. It currently resolves to ` +
          'cacheable (package override absent and the root task caches), which would replay a logged green without ' +
          'ever dlopening the addon.'
      );
    }
  });
}

/*
 * BST-2243: a CONSUMER whose source loads a native add-on at import must order
 * its unit `test` lane after that add-on's build.
 *
 * The add-on's `build` is an uncached `node-gyp rebuild`, which first removes
 * build/. The root `test` task depends only on `topo`. So in a `turbo run test`
 * that also schedules the rebuild, for any dependent whose lane declares it,
 * the two run concurrently, and the consumer's suites fail with "Could not
 * locate the bindings file". Merge-queue gate run 39335264149 failed
 * host-lease that way.
 *
 * The rule is static and conservative. A package whose src/ statically
 * imports the add-on at runtime (not `import type`) declares `<add-on>#build`
 * in its own tasks.test.dependsOn, as packages/state-store already does (root
 * turbo.jsonc's B4 rule). Lazy loads (createRequire, dynamic import) are out of
 * scope; state-store declares its own edges for those.
 */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

/** Runtime source files under `srcDir`, excluding tests and their fixtures. */
function runtimeSourceFiles(srcDir) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
          visit(full);
        }
      } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        files.push(full);
      }
    }
  };
  if (existsSync(srcDir)) {
    visit(srcDir);
  }
  return files;
}

/** Package names of the workspace's native add-ons. */
function nativeAddonNames() {
  return new Set(
    nativeAddonPackageDirs().map(
      (dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name
    )
  );
}

/** Each consumer package (repo-relative dir) and the add-ons its src/ statically imports. */
function staticAddonConsumers(addons) {
  const consumers = new Map();
  for (const dir of workspacePackageDirs()) {
    const imported = new Set();
    for (const file of runtimeSourceFiles(path.join(dir, 'src'))) {
      for (const specifier of staticImportSpecifiers(readFileSync(file, 'utf8'), file)) {
        if (addons.has(specifier)) {
          imported.add(specifier);
        }
      }
    }
    if (imported.size > 0) {
      consumers.set(path.relative(repoRoot, dir).split(path.sep).join('/'), [...imported].sort());
    }
  }
  return consumers;
}

/** The `<add-on>#build` edges a consumer's tasks.test.dependsOn lacks. */
function missingAddonTestEdges(turbo, imported) {
  const dependsOn = turbo?.tasks?.test?.dependsOn ?? [];
  return imported.map((name) => `${name}#build`).filter((edge) => !dependsOn.includes(edge));
}

function consumerTurbo(rel) {
  const turboPath = path.join(repoRoot, rel, 'turbo.json');
  return existsSync(turboPath) ? readJsonc(turboPath) : undefined;
}

test('static native add-on consumers are discovered (fails vacuously otherwise)', () => {
  const consumers = staticAddonConsumers(nativeAddonNames());
  assert.ok(
    consumers.size > 0,
    'Expected at least one package whose src/ statically imports a native add-on ' +
      '(e.g. packages/host-lease imports @brainstrike/secure-fs-native). If none remain, delete this contract.'
  );
});

test('every package whose src/ statically imports a native add-on orders its unit test after that build', () => {
  const failures = [];
  for (const [rel, imported] of staticAddonConsumers(nativeAddonNames())) {
    const missing = missingAddonTestEdges(consumerTurbo(rel), imported);
    if (missing.length > 0) {
      failures.push(`${rel}: tasks.test.dependsOn lacks ${missing.join(', ')}`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    'A unit lane that loads a native add-on at import must depend on that add-on build, or a ' +
      'concurrent `node-gyp rebuild` (which removes build/ first) fails it with "Could not locate the ' +
      'bindings file". Declare ["$TURBO_EXTENDS$", "<add-on>#build"] in the package turbo.json `test` task:\n' +
      failures.join('\n')
  );
});

test('CONTROL: dropping one consumer edge FAILS the static add-on contract', () => {
  const consumers = [...staticAddonConsumers(nativeAddonNames())];
  assert.ok(consumers.length > 0, 'no consumer to mutate');
  for (const [rel, imported] of consumers) {
    const turbo = consumerTurbo(rel);
    const dropped = `${imported[0]}#build`;
    const mutated = {
      ...turbo,
      tasks: {
        ...turbo?.tasks,
        test: {
          ...turbo?.tasks?.test,
          dependsOn: (turbo?.tasks?.test?.dependsOn ?? []).filter((edge) => edge !== dropped),
        },
      },
    };
    assert.deepEqual(
      missingAddonTestEdges(mutated, imported),
      [dropped],
      `${rel} without ${dropped}`
    );
  }
});

test('CONTROL: a type-only import is not a runtime add-on import; a value import is', () => {
  const name = [...nativeAddonNames()][0];
  assert.deepEqual(staticImportSpecifiers(`import type { X } from '${name}';`), []);
  assert.deepEqual(staticImportSpecifiers(`import { type X } from '${name}';`), []);
  assert.deepEqual(staticImportSpecifiers(`import { X } from '${name}';`), [name]);
});
