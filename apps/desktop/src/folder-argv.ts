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
 * The unpackaged skip mirrors Electron's own argv convention: `electron .`
 * puts the app directory at argv[1]. Without the skip, every dev launch would
 * ask to mount the repo.
 */
export interface FolderArgvParams {
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
  argv,
  isPackaged,
  platform = process.platform,
  workingDirectory,
}: FolderArgvParams): readonly string[] {
  const positional = argv.slice(isPackaged ? 1 : 2);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of positional) {
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
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(resolved);
  }
  return candidates;
}
