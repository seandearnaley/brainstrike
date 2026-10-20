/**
 * The @smoke tests that do not run on Windows yet, each with its concrete
 * reason (BST-2190). The packaged desktop smoke runs nightly on windows-2025;
 * every test named here calls `test.fixme(process.platform === 'win32', …)`
 * with its entry, so Playwright reports it as fixme with this text instead of
 * filtering it out. These are gaps in POSIX-only test fixtures, not in the app.
 */
export const WINDOWS_SMOKE_EXCLUSIONS = {
  /** forge-pr.desktop.test.ts: every test, including both @smoke tests. */
  posixGhShim:
    'The fake gh (e2e/utils/gh-shim.ts) is an extensionless #!/bin/sh script. The app runs execFile("gh") without a shell (forge-gh-client.ts), which on Windows resolves only gh.exe or gh.com, so the shim never runs.',
  /** add-root-ui.smoke.desktop.test.ts: "…opens a shell at that root". */
  posixShellCommand:
    'The test types the POSIX command `[ "$(pwd)" = … ] && echo …` into the terminal, but the Windows terminal shell is %ComSpec%, cmd.exe (terminal-ipc-handlers.ts).',
} as const;
