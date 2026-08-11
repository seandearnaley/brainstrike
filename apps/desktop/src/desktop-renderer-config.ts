export const DEFAULT_DESKTOP_DEV_RENDERER_PORT = 38_181;

const DEFAULT_DESKTOP_DEV_RENDERER_URL = `http://localhost:${DEFAULT_DESKTOP_DEV_RENDERER_PORT}`;

interface ResolvedDesktopDevRendererConfig {
  port: number;
  url: string;
}

export type DesktopDevRendererConfigResolution =
  | (ResolvedDesktopDevRendererConfig & { kind: 'default' })
  | (ResolvedDesktopDevRendererConfig & { kind: 'override' })
  | (ResolvedDesktopDevRendererConfig & {
      configuredUrl: string;
      kind: 'invalid-override';
    });

function resolveDefaultConfig(): ResolvedDesktopDevRendererConfig {
  return {
    port: DEFAULT_DESKTOP_DEV_RENDERER_PORT,
    url: DEFAULT_DESKTOP_DEV_RENDERER_URL,
  };
}

export function resolveDesktopDevRendererConfig(
  configuredUrlValue: string | undefined
): DesktopDevRendererConfigResolution {
  const configuredUrl = configuredUrlValue?.trim();
  if (!configuredUrl) {
    return { ...resolveDefaultConfig(), kind: 'default' };
  }

  try {
    const parsedUrl = new URL(configuredUrl);
    const parsedPort = Number.parseInt(parsedUrl.port, 10);
    const isHttpRendererUrl = parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    if (isHttpRendererUrl && Number.isFinite(parsedPort) && parsedPort > 0) {
      return {
        kind: 'override',
        port: parsedPort,
        url: configuredUrl,
      };
    }
  } catch {
    // The discriminated result makes the invalid override visible to each caller.
  }

  return {
    ...resolveDefaultConfig(),
    configuredUrl,
    kind: 'invalid-override',
  };
}
