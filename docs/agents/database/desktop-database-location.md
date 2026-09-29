# Where the desktop database lives — evidence

Supports `docs/agents/database.md` § "DESKTOP DATABASE LOCATION".

Packaged builds resolve their database from `app.isPackaged` and an OS-canonical data folder, main resolves once, and the DB host derives nothing. Read before changing a location, the precedence, or how the host is told where to open. The contract holds the rules; this file is the record behind them (BST-1873).

## The defect

`db-main.ts` chose its production path only when `process.env.NODE_ENV === 'production'`. Nothing sets that variable for a desktop app: `apps/desktop/scripts/build-main-config.mjs` has no `define`, main bootstrap never assigns it, and the desktop `.env` allow-list (`desktop-env.ts`) does not admit it. `app.isPackaged` was never consulted. A packaged build therefore resolved to `~/Documents/BrainStrike-dev` with a profile taken from the git branch of the launch directory's `process.cwd()`, or `dev-default` when there was none.

The DB host compounded it. `createDbHostEnvironment()` always passed the root path but forwarded the profile only when main's own environment already carried one, so the utility process re-derived the profile from its own cwd at spawn time. A branch switch between main's cached read and a host (re)spawn left main and host disagreeing about the profile, and main's reset path (`resetLocalDatabaseInternal`) would back up and delete main's profile, not the one the host had open. The packaged CI smoke always passes `--test-mode`, so the production branch was never exercised anywhere.

## Why these locations

- macOS `<userData>/data`: Electron's `app.getPath` docs advise storing app-specific files in a subdirectory of `userData` rather than in it, to avoid clashing with Chromium's own subdirectories (`Cache`, `GPUCache`, `Local Storage`). `userData` is under `~/Library/Application Support`.
- Windows `%LOCALAPPDATA%\<product>\data`: Electron's `userData` is under `%APPDATA%` (Roaming), and its docs warn that some environments back that directory up to cloud storage and that large files are not recommended there. A PGlite data directory must not roam, so Windows uses the non-roaming known folder. A missing or relative `LOCALAPPDATA` throws.
- Linux `$XDG_DATA_HOME/<product>/data`, defaulting to `~/.local/share`: the XDG Base Directory specification, which treats an empty or relative `XDG_DATA_HOME` as invalid and ignores it.
- The folder name is `build.productName` (`BrainStrike Desktop`). The desktop `package.json` carries `productName` only under `build`, not at its top level, so the name is a constant pinned to that field by a test rather than derived from Electron's app name at runtime.

## Precedence change

Before, a test run forced profile `test` even when `BRAINSTRIKE_DB_PROFILE` was set, while `BRAINSTRIKE_DB_ROOT_PATH` always won. Now each explicit override wins for its own field, so a test run with an explicit profile uses it. No harness sets a profile override; `apps/desktop/e2e/utils/electron-helpers.mts` and `start-agent-devtools-session.mjs` set only the root.

## Factory reset

`resetDesktopApplicationData` stops runtimes, then runs `resetDatabaseProfile` (which closes the DB host through `closeDbHostManager` and deletes the profile), and only then stages `userData` entries for deletion. On packaged macOS the database root is inside `userData`, so the wipe removes `data` with everything else, including the backups the same reset just made under `<root>/backups`. Where the root is outside `userData` (Windows, Linux, development) `<root>/backups` survives a factory reset; retention is the five newest per profile.

## Open points

- `DefaultDbHostManager.close()` sends a close request and waits up to two seconds for the acknowledgement, then calls `host.kill()` without awaiting the process exit. A host wedged past that timeout can still be exiting while the reset removes its directory. This predates the location change and applies equally to test-mode roots inside `userData`.
- No packaged end-to-end run exercises the production location: the packaged smoke passes `--test-mode`. The unit tables in `database-location.test.ts` and the real-filesystem layout test are the only coverage.
