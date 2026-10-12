/** Owner-scoped M3 exclusion; shared by preload presentation and Main admission. */
export function getFactoryResetUnavailableReason(platform: string): string | undefined {
  return platform === 'win32'
    ? 'Factory reset is unavailable on Windows in this version.'
    : undefined;
}
