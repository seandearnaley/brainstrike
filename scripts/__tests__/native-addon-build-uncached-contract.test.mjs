import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

/** Workspace packages that compile a native addon, across every workspace root. */
function nativeAddonPackageDirs() {
  const dirs = [];
  for (const prefix of workspaceGlobPrefixes()) {
    const base = path.join(repoRoot, prefix);
    if (!existsSync(base)) {
      continue;
    }
    for (const name of readdirSync(base)) {
      const pkgPath = path.join(base, name, 'package.json');
      if (!existsSync(pkgPath)) {
        continue;
      }
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const buildScript = pkg.scripts?.build ?? '';
      if (pkg.gypfile === true || /node-gyp\s+(rebuild|build)/.test(buildScript)) {
        dirs.push(path.join(base, name));
      }
    }
  }
  return dirs;
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
