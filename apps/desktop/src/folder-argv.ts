import path from 'node:path';

/**
 * `brainstrike <path>` and `second-instance` argv → absolute folder CANDIDATES
 * (BST-1393, spec §7 [D10]).
 *
 * CANDIDATES, emphatically: this function performs no I/O, asserts nothing
 * about the filesystem, and authorizes nothing. `main.ts` stats each result
 * (`filterDirectoryOpenCandidates` in `workspace-open-queue.ts`) to confirm it
 * is a real, readable directory before it ever reaches the queue, and the
 * renderer routes a survivor through `fs:addRootByPath`, whose two gates
 * decide whether it may be MOUNTED at all (ruling S1). argv is
 * attacker-influencable — another process can launch this app with any
 * argument — so nothing downstream of here treats a candidate as consent.
 *
 * The unpackaged app-path skip is by IDENTITY, never by argv position:
 * `electron .` passes the app directory as a positional, but Chromium
 * regroups the argv it delivers to the first instance's `second-instance`
 * handler as [program, ...switches, ...positionals] — switches (including
 * ones Chromium injects itself) move ahead of positionals, so the app-path
 * argument can land at any index. Observed live (BST-1393 L5, 2026-08-27,
 * Electron 43): `electron . --no-sandbox --…=dev-server <dir>` arrived with
 * `.` at index 5; a fixed `slice(2)` let it resolve against the working
 * directory and enqueue the repo checkout as a folder-open candidate. The
 * skip therefore drops any positional that RESOLVES to `appPath`, and only
 * when unpackaged — packaged argv has no app-path positional to recognize,
 * and packaged parsing is unchanged.
 */
export interface FolderArgvParams {
  /**
   * `app.getAppPath()` of the RECEIVING instance — for `electron <app-dir>`
   * this is the resolved app directory. Consulted only when `isPackaged` is
   * false, to recognize the app-path positional by identity (see above). A
   * second instance launched from a DIFFERENT checkout resolves to a
   * different appPath and its app-path argument survives as a candidate;
   * that is inherent (this process cannot know another checkout's app path)
   * and harmless — candidates are requests, and the stat filter plus mount
   * gates downstream still hold.
   */
  readonly appPath: string;
  readonly argv: readonly string[];
  readonly isPackaged: boolean;
  /**
   * Defaults to `process.platform`. Threaded through explicitly — like every
   * other input this function needs — rather than read from ambient global
   * state, so the win32 case-insensitive dedupe branch below is exercisable
   * from `folder-argv.test.ts` on any CI runner, not just Windows.
   */
  readonly platform?: NodeJS.Platform;
  readonly workingDirectory: string;
}

export function resolveFolderCandidatesFromArgv({
  appPath,
  argv,
  isPackaged,
  platform = process.platform,
  workingDirectory,
}: FolderArgvParams): readonly string[] {
  const toKey = (resolved: string): string =>
    platform === 'win32' ? resolved.toLowerCase() : resolved;
  // Same key shape as the dedupe below (resolved + win32 case-fold), so every
  // spelling of the app dir — `.`, absolute, trailing separator, other case
  // on Windows — collapses onto the same identity.
  const appPathKey = isPackaged ? null : toKey(path.resolve(appPath));
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of argv.slice(1)) {
    // `trimmed` is used ONLY to detect a whitespace-only or switch-shaped
    // argument — never to build the path. A quoted CLI argument can legally
    // name a Unix/macOS directory whose name begins or ends with whitespace;
    // trimming `raw` before resolving it would silently corrupt that path
    // (reject it as nonexistent, or worse, resolve to a different, existing
    // folder with the trimmed name).
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('-')) {
      continue;
    }
    // `path.resolve` normalizes and strips a trailing separator, which is the
    // same key shape `normalizeRecentRootPath` uses, so `/w/repo` and
    // `/w/repo/` collapse to one candidate here as well as in the ledger.
    // Resolved from the RAW, untrimmed value — see the comment above.
    const resolved = path.resolve(workingDirectory, raw);
    const key = toKey(resolved);
    if (key === appPathKey || seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(resolved);
  }
  return candidates;
}
