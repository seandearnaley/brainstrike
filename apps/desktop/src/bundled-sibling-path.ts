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
 * e2e harness does) and cannot substitute for this. This helper resolves
 * `__filename` — the real on-disk path of the running bundle, set by Node's
 * actual CJS module wrapper. It is deliberately NOT `module.filename`
 * (PR #2680 review, codex + claude[bot] independently): both hold the same
 * value in the real Electron process, but Vite's Vitest module transform
 * provides only a synthetic `module = { exports }` shim with NO `.filename`
 * for files that reach this code through main.ts's real bootstrap path —
 * proven empty by this ticket's own full-suite gate (12 tests across 7
 * files broke the moment that silently-wrong value became load-bearing). It
 * is also NOT `import.meta.filename` (PR #2680 delta re-review — ultracite's
 * own autofix tried to rewrite this to it): esbuild's `cjs` output format
 * leaves `import.meta` EMPTY, by esbuild's own `[empty-import-meta]` build
 * warning, which would make this throw on every real call. `__filename`
 * remains populated in both the esbuild CJS bundle AND under Vitest, so it
 * is the only one of the three identifiers that is correct everywhere this
 * code runs — anyone "correcting" this back to `module.filename` or
 * `import.meta.filename` reintroduces one of the two failures this ticket
 * diagnosed and fixed.
 *
 * `currentModuleFilename` is an injectable override purely for unit tests
 * (see `apps/desktop/src/__tests__/diagnostics/main-watchdog-path.test.ts`
 * and its siblings) — always resolved LAZILY inside the branch that needs
 * it, never as a default-parameter expression, so a call that never reaches
 * dev-mode resolution (e.g. every packaged-mode call) provably never reads
 * `__filename` at all.
 *
 * NO SILENT FALLBACKS: an empty/missing `__filename` throws loudly rather
 * than degrading to a plausible-but-wrong `process.cwd()`-relative guess —
 * a prior draft of this fix did exactly that "on the record" as vestigial
 * rather than removing it, which is the exact silent-degradation shape
 * AGENTS.md forbids, and a WORSE failure than the bug this ticket fixed
 * (the old `dist/dist/` doubling at least failed loudly at `Worker`
 * construction).
 */
export function resolveBundledModuleDir(
  contextLabel: string,
  currentModuleFilename?: string
): string {
  // biome-ignore lint/correctness/noGlobalDirnameFilename: esbuild's cjs output format leaves import.meta EMPTY (its own [empty-import-meta] build warning) — __filename is the correct, populated choice for this bundle; see the module docblock above.
  const moduleFilename = currentModuleFilename ?? __filename;
  if (typeof moduleFilename !== 'string' || moduleFilename.length === 0) {
    throw new Error(
      `${contextLabel}: __filename unavailable (module.filename/import.meta.filename are unavailable/empty in this bundle+test matrix — see this module's docblock); cannot resolve dist/`
    );
  }
  return path.dirname(moduleFilename);
}

/** Resolve `fileName` as a sibling of the running bundled module in `dist/`. */
export function resolveBundledSiblingPath(
  contextLabel: string,
  fileName: string,
  currentModuleFilename?: string
): string {
  return path.join(resolveBundledModuleDir(contextLabel, currentModuleFilename), fileName);
}
