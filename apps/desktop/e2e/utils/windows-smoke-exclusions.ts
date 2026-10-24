/**
 * The @smoke tests that do not run on Windows yet, each with its concrete
 * reason (BST-2190). The packaged desktop smoke runs nightly on windows-2025;
 * every test named here calls `test.fixme(process.platform === 'win32', …)`
 * with its entry, so Playwright reports it as fixme with this text instead of
 * filtering it out. The first is a gap in a POSIX-only test fixture, not in the
 * app; the second is a suspected product race with its own issue.
 */
export const WINDOWS_SMOKE_EXCLUSIONS = {
  /** forge-pr.desktop.test.ts: every test, including both @smoke tests. */
  posixGhShim:
    'The fake gh (e2e/utils/gh-shim.ts) is an extensionless #!/bin/sh script. The app runs execFile("gh") without a shell (forge-gh-client.ts), which on Windows resolves only gh.exe or gh.com, so the shim never runs.',
  /** host-thread-unavailable-root-reopen.desktop.test.ts: its one test. */
  staleCatalogModelSelection:
    'BST-2242, suspected product race, not a fixture gap: on hosted windows-2025 (run 39336738388) the catalog read back openrouter::anthropic/claude-sonnet-4.6 as enabled, yet the composer stayed disabled for 30 s on "The selected catalog model is disabled".',
} as const;
