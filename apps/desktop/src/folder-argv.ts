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
 * skip therefore drops the FIRST positional that RESOLVES to `appPath` or to
 * `appEntryPath` (the FILE-entry launch spelling, BST-1459) — the implicit
 * app argument; a later duplicate is the caller explicitly asking to open
 * the app dir (`electron . .`) and stays a candidate — and only when
 * unpackaged: packaged argv has no app-path positional to recognize, and
 * packaged parsing is unchanged.
 */
export interface FolderArgvParams {
  /**
   * The running bundled main module's own on-disk path (`__filename` in
   * main; see bundled-sibling-path.ts for why `__filename` specifically).
   * Recognizes the FILE-entry launch spelling `electron <path>/dist/main.js`
   * — the desktop Playwright harness's shape — where `app.getAppPath()` is
   * dist/ ITSELF (BST-1459) and so never equals the entry positional. Same
   * value in both unpackaged spellings, since `electron .` also executes
   * dist/main.js via package.json `main`. Consulted only when unpackaged.
   */
  readonly appEntryPath: string;
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
  appEntryPath,
  appPath,
  argv,
  isPackaged,
  platform = process.platform,
  workingDirectory,
}: FolderArgvParams): readonly string[] {
  // NO SILENT FALLBACK: `path.resolve('')` is the working directory, so an
  // empty identity would silently swallow a legitimate `.` candidate — the
  // exact misparse shape this module exists to prevent. Malformed input
  // throws loudly instead.
  if (appPath.trim().length === 0) {
    throw new TypeError('resolveFolderCandidatesFromArgv: appPath must be a non-empty path');
  }
  if (appEntryPath.trim().length === 0) {
    throw new TypeError('resolveFolderCandidatesFromArgv: appEntryPath must be a non-empty path');
  }
  const toKey = (resolved: string): string =>
    platform === 'win32' ? resolved.toLowerCase() : resolved;
  // Same key shape as the dedupe below (resolved + win32 case-fold), so every
  // spelling of the app dir — `.`, absolute, trailing separator, other case
  // on Windows — collapses onto the same identity.
  const appPathKey = isPackaged ? null : toKey(path.resolve(appPath));
  // The FILE-entry spelling of the same implicit argument (BST-1459): under
  // `electron <path>/dist/main.js` the app "path" Electron reports is dist/,
  // and the positional is the entry FILE — recognized by the running
  // bundle's own filename instead of falling through to the stat filter.
  const appEntryKey = isPackaged ? null : toKey(path.resolve(appEntryPath));
  // The implicit `electron <app-dir>` argument appears exactly once, as the
  // FIRST app-path-valued positional (Chromium regroups switches ahead of
  // positionals but preserves the positionals' relative order — see the
  // captured shape in the docblock). Skip only that occurrence: a LATER
  // positional naming the same directory is the caller explicitly asking to
  // open the app dir (`electron . .`) and stays a candidate, exactly as the
  // old positional parse allowed.
  let implicitAppArgPending = !isPackaged;
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
    if (implicitAppArgPending && (key === appPathKey || key === appEntryKey)) {
      implicitAppArgPending = false;
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(resolved);
  }
  return candidates;
}
