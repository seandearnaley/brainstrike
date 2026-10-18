#!/usr/bin/env node
// Release smoke gate (.github/workflows/release.yml): every native addon a
// packaged macOS app can load must contain the DMG's architecture. Usage:
//   node scripts/verify-macos-addon-archs.mjs "<path to .app>" <arm64|x64>
//
// The rule, per Mach-O `.node` under Contents/Resources/app.asar.unpacked:
// - It contains the target arch: fine.
// - Its path names the OTHER darwin arch (`darwin-x64`, `darwin/arm64`, …):
//   an alternate a multi-arch package selects between at runtime. Fine only
//   if the same path with the target arch exists; a package that shipped only
//   the other arch's binary fails here.
// - Otherwise it is a single binary for the wrong arch: fails.
// A `.node` that is not Mach-O is another OS's prebuild and is never loaded on
// macOS. Paths are handled as values, so the mounted volume's spaces are safe.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIPO_ARCH = { arm64: 'arm64', x64: 'x86_64' };

function* addons(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* addons(full);
    } else if (entry.isFile() && entry.name.endsWith('.node')) {
      yield full;
    }
  }
}

/** @returns {string[] | null} the addon's Mach-O archs, or null for a non-Mach-O file */
function machoArchs(file) {
  try {
    return execFileSync('/usr/bin/lipo', ['-archs', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split(/\s+/u);
  } catch {
    return null;
  }
}

/** The same path for `target` when `file` names the other darwin arch, else null. */
export function targetAlternate(file, target, other) {
  const named = new RegExp(`darwin([-/])${other}(?=[-/.]|$)`, 'gu');
  return named.test(file) ? file.replace(named, `darwin$1${target}`) : null;
}

export function verifyAddonArchs(app, target, archsOf = machoArchs, exists = existsSync) {
  const want = LIPO_ARCH[target];
  const other = target === 'arm64' ? 'x64' : 'arm64';
  if (!want) {
    throw new Error(`unsupported target arch "${target}"`);
  }
  const root = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked');
  const failures = [];
  let checked = 0;
  for (const file of addons(root)) {
    const archs = archsOf(file);
    if (archs === null || archs.includes(want)) {
      checked += archs === null ? 0 : 1;
      continue;
    }
    checked += 1;
    const alternate = targetAlternate(file, target, other);
    if (alternate !== null && exists(alternate)) {
      continue;
    }
    failures.push(
      `${path.relative(root, file)} is ${archs.join(' ')}, not ${want}` +
        (alternate === null ? '' : `, and ${path.relative(root, alternate)} is missing`)
    );
  }
  return { checked, failures };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [app, target] = process.argv.slice(2);
  if (!(app && target)) {
    console.error('usage: verify-macos-addon-archs.mjs <app> <arm64|x64>');
    process.exit(2);
  }
  const { checked, failures } = verifyAddonArchs(app, target);
  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }
  console.log(`${checked} Mach-O addons checked for ${target}; ${failures.length} unloadable.`);
  process.exitCode = failures.length === 0 && checked > 0 ? 0 : 1;
}
