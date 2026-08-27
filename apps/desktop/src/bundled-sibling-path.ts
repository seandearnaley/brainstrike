import path from 'node:path';

/**
 * Resolve a plain filesystem path for a file that esbuild emits as a SIBLING
 * of the running bundled main-process module in `dist/` (see
 * `scripts/build-main-config.mjs`'s docblock: `bundle: true` means every
 * main-process entry point — main.js, main-watchdog-worker.js,
 * main-log-transport.js, db-host-entry.js, parser-host-entry.js — lands
 * directly in `dist/`, one file each, regardless of how Electron was
 * launched).
 *
 * BST-1459: `app.getAppPath()` is launch-mode-dependent (it returns the
 * project root under `electron .`, but `dist/` itself when Electron is
 * launched with a direct path to `dist/main.js`, as Playwright's desktop
 * e2e harness does) and cannot substitute for this. `__filename` is used
 * instead of `module.filename` (PR #2680 review, codex + claude[bot]
 * independently): both hold the identical real on-disk path of the running
 * bundle in Node's actual CJS module wrapper, but Vite's Vitest module
 * transform provides only a synthetic `module = { exports }` shim with no
 * `.filename` for files that reach this code through main.ts's real
 * bootstrap path — `__filename` remains populated there too, so this stays
 * correct in both the packaged/dev Electron process AND under test, with no
 * environment-specific accommodation needed.
 *
 * `currentModuleFilename` is an injectable override purely for unit tests
 * (see `apps/desktop/src/__tests__/diagnostics/main-watchdog-path.test.ts`
 * and its siblings) — always resolved LAZILY inside the branch that needs
 * it, never as a default-parameter expression, so a call that never reaches
 * dev-mode resolution (e.g. every packaged-mode call) provably never reads
 * `__filename` at all.
 *
 * NO SILENT FALLBACKS: an empty/missing module filename throws loudly
 * rather than degrading to a plausible-but-wrong `process.cwd()`-relative
 * guess — a prior draft of this fix did exactly that "on the record" as
 * vestigial rather than removing it, which is the exact silent-degradation
 * shape AGENTS.md forbids, and a WORSE failure than the bug this ticket
 * fixed (the old `dist/dist/` doubling at least failed loudly at `Worker`
 * construction).
 *
 * FOLLOW-UP (not fixed here — different ticket, flagged as debt):
 * `db-host-manager.ts`'s `resolveDefaultEntryPath()` and
 * `parser-host-manager.ts`'s equivalent predate this helper and still
 * inline their own `module.filename`-with-`process.cwd()`-fallback copy of
 * this idiom, unmodified. They should eventually consume this helper too.
 */
export function resolveBundledDistDir(
  contextLabel: string,
  currentModuleFilename?: string
): string {
  // biome-ignore lint/correctness/noGlobalDirnameFilename: esbuild's cjs output format leaves import.meta EMPTY (its own [empty-import-meta] build warning) — __filename is the correct, populated choice for this bundle; see the module docblock above.
  const moduleFilename = currentModuleFilename ?? __filename;
  if (typeof moduleFilename !== 'string' || moduleFilename.length === 0) {
    throw new Error(`${contextLabel}: module.filename unavailable; cannot resolve dist/`);
  }
  return path.dirname(moduleFilename);
}

/** Resolve `fileName` as a sibling of the running bundled module in `dist/`. */
export function resolveBundledSiblingPath(
  contextLabel: string,
  fileName: string,
  currentModuleFilename?: string
): string {
  return path.join(resolveBundledDistDir(contextLabel, currentModuleFilename), fileName);
}
