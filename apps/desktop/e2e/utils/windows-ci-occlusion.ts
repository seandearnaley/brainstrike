/**
 * Chromium's Windows native-occlusion calculation: "If enabled, calculate native window
 * occlusion - Windows-only" (`kCalculateNativeWinOcclusion`, enabled by default,
 * ui/base/ui_base_features.cc). Its tracker "keeps track of whether any HWNDs are occluding
 * any app windows" and "notifies the host of any app window whose occlusion state changes"
 * (ui/aura/native_window_occlusion_tracker_win.h). Electron's own Windows CI ran with it
 * disabled until electron/electron#34374, because it changes page visibility there
 * (electron/electron#29195).
 */
export const WINDOWS_NATIVE_OCCLUSION_FEATURE = 'CalculateNativeWinOcclusion';

const DISABLE_FEATURES = '--disable-features=';

/**
 * BST-2239: on Windows CI the E2E window stays hidden, and Playwright screenshots every page
 * of a closing app before it asks Main to quit, inside the harness's 10 s close deadline.
 * On hosted windows-2025 that screenshot of the hidden window took 2.2–4.3 s or hit its 5 s
 * timeout (run 39336738388); on macOS it takes 93 ms. So Windows CI launches without the
 * occlusion calculation. The window stays hidden: showing it made the capture fast, but
 * Main then crashed in Electron teardown (BST-2244, run 39340569328). Chromium reads only the
 * last `--disable-features` switch, so the feature joins the existing list.
 */
export function withWindowsCiOcclusionDisabled(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): string[] {
  if (!(platform === 'win32' && env['CI'] === 'true')) {
    return [...args];
  }
  const lists = args.filter((arg) => arg.startsWith(DISABLE_FEATURES));
  if (lists.length > 1) {
    throw new Error(`Expected at most one ${DISABLE_FEATURES} switch, found ${lists.length}`);
  }
  if (lists.length === 0) {
    return [...args, `${DISABLE_FEATURES}${WINDOWS_NATIVE_OCCLUSION_FEATURE}`];
  }
  return args.map((arg) =>
    arg.startsWith(DISABLE_FEATURES) ? `${arg},${WINDOWS_NATIVE_OCCLUSION_FEATURE}` : arg
  );
}
