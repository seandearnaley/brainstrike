/**
 * Whether the E2E app shows its test-mode window unfocused (`'1'`) or keeps it hidden (`''`).
 * Hidden is the default, so runs never pop up on a developer's desktop. CI machines on Linux
 * and Windows have no user to disturb, and there a never-shown window renders no usable frames:
 *
 * - Linux (BST-2040): Chromium renders a window X11 never mapped at one frame per second.
 * - Windows (BST-2239): on hosted windows-2025, Playwright's screenshot of the hidden window
 *   took 2.2–4.3 s or hit its 5 s timeout (run 39336738388). Playwright takes that screenshot of
 *   every page as the app closes, before it asks Main to quit, so it ran inside the harness's
 *   10 s close deadline. The screenshot stays on: an Electron trace records no visuals.
 *
 * An explicit value wins either way: `1` to show it, `''` to keep it hidden.
 */
export function e2eShowInactive(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): string {
  return (
    env['BRAINSTRIKE_E2E_SHOW_INACTIVE'] ??
    ((platform === 'linux' || platform === 'win32') && env['CI'] === 'true' ? '1' : '')
  );
}
