const DEFAULT_DESKTOP_DEV_RENDERER_PORT = 38_181;

function resolveDesktopDevRendererPort(): number {
  const configuredUrl = process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']?.trim();
  if (!configuredUrl) {
    return DEFAULT_DESKTOP_DEV_RENDERER_PORT;
  }

  try {
    const parsedUrl = new URL(configuredUrl);
    const parsedPort = Number.parseInt(parsedUrl.port, 10);
    return Number.isFinite(parsedPort) && parsedPort > 0
      ? parsedPort
      : DEFAULT_DESKTOP_DEV_RENDERER_PORT;
  } catch {
    return DEFAULT_DESKTOP_DEV_RENDERER_PORT;
  }
}

export const DESKTOP_DEV_RENDERER_PORT = resolveDesktopDevRendererPort();
export const DESKTOP_DEV_RENDERER_URL =
  process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']?.trim() ||
  `http://localhost:${DESKTOP_DEV_RENDERER_PORT}`;
