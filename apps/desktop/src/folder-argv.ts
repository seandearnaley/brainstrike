import path from 'node:path';

/**
 * `brainstrike <path>` and `second-instance` argv → absolute folder CANDIDATES
 * (BST-1393, spec §7 [D10]).
 *
 * CANDIDATES, emphatically: this function performs no I/O, asserts nothing
 * about the filesystem, and authorizes nothing. main stats each result to
 * confirm it is a directory, and the renderer routes it through
 * `fs:addRootByPath`, whose two gates decide whether it may be mounted at all
 * (ruling S1). argv is attacker-influencable — another process can launch this
 * app with any argument — so nothing downstream of here treats a candidate as
 * consent.
 *
 * The unpackaged skip mirrors Electron's own argv convention: `electron .`
 * puts the app directory at argv[1]. Without the skip, every dev launch would
 * ask to mount the repo.
 */
export interface FolderArgvParams {
  readonly argv: readonly string[];
  readonly isPackaged: boolean;
  readonly workingDirectory: string;
}

export function resolveFolderCandidatesFromArgv({
  argv,
  isPackaged,
  workingDirectory,
}: FolderArgvParams): readonly string[] {
  const positional = argv.slice(isPackaged ? 1 : 2);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of positional) {
    const value = raw.trim();
    if (value.length === 0 || value.startsWith('-')) {
      continue;
    }
    // `path.resolve` normalizes and strips a trailing separator, which is the
    // same key shape `normalizeRecentRootPath` uses, so `/w/repo` and
    // `/w/repo/` collapse to one candidate here as well as in the ledger.
    const resolved = path.resolve(workingDirectory, value);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(resolved);
  }
  return candidates;
}
