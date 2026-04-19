export type DesktopRendererLaunchMode = 'built' | 'dev-server' | 'test-built';

const DESKTOP_LAUNCH_MODE_PREFIX = '--brainstrike-desktop-launch-mode=' as const;

function isDesktopRendererLaunchMode(value: string): value is DesktopRendererLaunchMode {
  return value === 'built' || value === 'dev-server' || value === 'test-built';
}

export function resolveDesktopRendererLaunchMode(params: {
  argv: readonly string[];
  isPackaged: boolean;
  isTestMode: boolean;
}): DesktopRendererLaunchMode {
  const explicitArgument = params.argv.find((value) =>
    value.startsWith(DESKTOP_LAUNCH_MODE_PREFIX)
  );
  if (explicitArgument) {
    const explicitValue = explicitArgument.slice(DESKTOP_LAUNCH_MODE_PREFIX.length).trim();
    if (!isDesktopRendererLaunchMode(explicitValue)) {
      throw new Error(
        `Unsupported desktop launch mode "${explicitValue}". Expected one of: built, dev-server, test-built.`
      );
    }
    return explicitValue;
  }

  if (params.isPackaged) {
    return 'built';
  }
  if (params.isTestMode) {
    return 'test-built';
  }
  return 'built';
}
