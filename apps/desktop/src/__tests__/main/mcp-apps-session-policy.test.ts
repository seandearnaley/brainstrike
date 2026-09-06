import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn }),
}));

import {
  __resetMcpAppSessionPolicyForTests,
  installMcpAppSessionPolicy,
  isMcpAppSandboxDownload,
  isSandboxedFramePermissionRequest,
  type McpAppSessionFrame,
} from '../../mcp/apps-session-policy';

const TOKEN = 'a'.repeat(32);
const SHELL = `brainstrike-mcp-app://${TOKEN}/`;
const CANVAS_SHELL = 'brainstrike-canvas://shell/';
const HOST =
  'file:///Applications/BrainStrike.app/Contents/Resources/app.asar/dist/renderer/index.html';

/** The main window while ONE MCP App is mounted next to a Canvas sandbox. */
const MOUNTED_FRAMES: readonly McpAppSessionFrame[] = [
  { parentUrl: undefined, url: HOST },
  { parentUrl: HOST, url: SHELL },
  { parentUrl: SHELL, url: 'about:srcdoc' },
  { parentUrl: HOST, url: CANVAS_SHELL },
  { parentUrl: CANVAS_SHELL, url: 'about:srcdoc' },
];

/** The main window with no MCP App mounted (a Canvas sandbox is open). */
const CANVAS_ONLY_FRAMES: readonly McpAppSessionFrame[] = [
  { parentUrl: undefined, url: HOST },
  { parentUrl: HOST, url: CANVAS_SHELL },
  { parentUrl: CANVAS_SHELL, url: 'about:srcdoc' },
];

/** The main window with no sandbox of any kind mounted. */
const HOST_ONLY_FRAMES: readonly McpAppSessionFrame[] = [{ parentUrl: undefined, url: HOST }];

beforeEach(() => {
  warn.mockClear();
  __resetMcpAppSessionPolicyForTests();
});

describe('isSandboxedFramePermissionRequest', () => {
  it('denies a sandbox shell frame by its own origin', () => {
    expect(
      isSandboxedFramePermissionRequest({
        frames: MOUNTED_FRAMES,
        isMainFrame: false,
        requestingUrl: SHELL,
      })
    ).toBe(true);
    // Even with nothing else in the tree to corroborate it.
    expect(
      isSandboxedFramePermissionRequest({ frames: [], isMainFrame: false, requestingUrl: SHELL })
    ).toBe(true);
    expect(
      isSandboxedFramePermissionRequest({
        frames: CANVAS_ONLY_FRAMES,
        isMainFrame: false,
        requestingUrl: CANVAS_SHELL,
      })
    ).toBe(true);
  });

  it('denies the opaque about:srcdoc app frame via its shell parent', () => {
    expect(
      isSandboxedFramePermissionRequest({
        frames: MOUNTED_FRAMES,
        isMainFrame: false,
        requestingUrl: 'about:srcdoc',
      })
    ).toBe(true);
  });

  it('denies the Canvas srcdoc sandbox with no MCP App mounted', () => {
    expect(
      isSandboxedFramePermissionRequest({
        frames: CANVAS_ONLY_FRAMES,
        isMainFrame: false,
        requestingUrl: 'about:srcdoc',
      })
    ).toBe(true);
  });

  it('leaves srcdoc frames alone when no sandbox shell is mounted', () => {
    expect(
      isSandboxedFramePermissionRequest({
        frames: HOST_ONLY_FRAMES,
        isMainFrame: false,
        requestingUrl: 'about:srcdoc',
      })
    ).toBe(false);
  });

  it('never denies the host renderer', () => {
    for (const frames of [MOUNTED_FRAMES, CANVAS_ONLY_FRAMES, HOST_ONLY_FRAMES, []]) {
      expect(
        isSandboxedFramePermissionRequest({ frames, isMainFrame: true, requestingUrl: HOST })
      ).toBe(false);
      expect(
        isSandboxedFramePermissionRequest({
          frames,
          isMainFrame: true,
          requestingUrl: 'http://localhost:5173/index.html',
        })
      ).toBe(false);
    }
  });

  it('denies an unattributable SUB frame check while a sandbox is mounted', () => {
    // `setPermissionCheckHandler` types `requestingUrl` as OPTIONAL and
    // Electron omits it for cross-origin sub frames — which is exactly what
    // the opaque sandbox document is. Fail closed.
    for (const requestingUrl of [undefined, '']) {
      expect(
        isSandboxedFramePermissionRequest({
          frames: MOUNTED_FRAMES,
          isMainFrame: false,
          requestingUrl,
        })
      ).toBe(true);
      expect(
        isSandboxedFramePermissionRequest({
          frames: CANVAS_ONLY_FRAMES,
          isMainFrame: false,
          requestingUrl,
        })
      ).toBe(true);
    }
  });

  it('leaves an unattributable MAIN frame to Electron', () => {
    expect(
      isSandboxedFramePermissionRequest({
        frames: MOUNTED_FRAMES,
        isMainFrame: true,
        requestingUrl: undefined,
      })
    ).toBe(false);
  });

  it('leaves an unattributable sub frame alone when no sandbox is mounted', () => {
    expect(
      isSandboxedFramePermissionRequest({
        frames: HOST_ONLY_FRAMES,
        isMainFrame: false,
        requestingUrl: undefined,
      })
    ).toBe(false);
  });

  it('does not match a look-alike scheme prefix', () => {
    for (const requestingUrl of ['brainstrike-mcp-apple://evil/', 'brainstrike-canvass://evil/']) {
      expect(
        isSandboxedFramePermissionRequest({
          frames: MOUNTED_FRAMES,
          isMainFrame: false,
          requestingUrl,
        })
      ).toBe(false);
    }
  });
});

describe('isMcpAppSandboxDownload', () => {
  it('denies a blob minted by a shell origin', () => {
    expect(isMcpAppSandboxDownload([`blob:${SHELL}9f0d-uuid`])).toBe(true);
  });

  it('denies a direct shell-scheme download', () => {
    expect(isMcpAppSandboxDownload([SHELL])).toBe(true);
  });

  it('denies when a shell origin appears anywhere in the redirect chain', () => {
    expect(isMcpAppSandboxDownload(['https://example.test/a', `blob:${SHELL}uuid`])).toBe(true);
  });

  it('allows host-renderer and ordinary downloads', () => {
    expect(isMcpAppSandboxDownload(['blob:file:///9f0d-uuid'])).toBe(false);
    expect(isMcpAppSandboxDownload(['blob:http://localhost:5173/9f0d-uuid'])).toBe(false);
    expect(isMcpAppSandboxDownload(['https://example.test/report.pdf'])).toBe(false);
    expect(isMcpAppSandboxDownload([])).toBe(false);
  });

  it('leaves the Canvas sandbox to its frame flags', () => {
    // The Canvas shell is itself `sandbox="allow-scripts"` (no
    // `allow-downloads`), so Chromium blocks its downloads before
    // `will-download` fires — unlike the MCP App shell, which is a real
    // origin in an unsandboxed iframe.
    expect(isMcpAppSandboxDownload([`blob:${CANVAS_SHELL}uuid`])).toBe(false);
  });
});

type ProbePermission = 'geolocation' | 'notifications';

interface CapturedSession {
  readonly check: (
    requestingUrl: string | undefined,
    options?: { readonly isMainFrame?: boolean; readonly permission?: ProbePermission }
  ) => boolean;
  readonly downloads: (url: string) => boolean;
  readonly installs: { permissionRequest: number; permissionCheck: number; willDownload: number };
  readonly request: (
    requestingUrl: string | undefined,
    options?: { readonly permission?: ProbePermission }
  ) => boolean;
  readonly session: Electron.Session;
}

function fakeSession(frames: readonly McpAppSessionFrame[]): CapturedSession {
  const installs = { permissionCheck: 0, permissionRequest: 0, willDownload: 0 };
  let requestHandler: Parameters<Electron.Session['setPermissionRequestHandler']>[0] = null;
  let checkHandler: Parameters<Electron.Session['setPermissionCheckHandler']>[0] = null;
  let downloadListener: ((event: Electron.Event, item: Electron.DownloadItem) => void) | null =
    null;

  const webContents = {
    isDestroyed: () => false,
    mainFrame: {
      framesInSubtree: frames.map((frame) => ({
        isDestroyed: () => false,
        parent: frame.parentUrl === undefined ? null : { url: frame.parentUrl },
        url: frame.url,
      })),
    },
  } as unknown as Electron.WebContents;

  const session = {
    on: (event: string, listener: (e: Electron.Event, item: Electron.DownloadItem) => void) => {
      expect(event).toBe('will-download');
      installs.willDownload += 1;
      downloadListener = listener;
      return session;
    },
    setPermissionCheckHandler: (
      handler: Parameters<Electron.Session['setPermissionCheckHandler']>[0]
    ) => {
      installs.permissionCheck += 1;
      checkHandler = handler;
    },
    setPermissionRequestHandler: (
      handler: Parameters<Electron.Session['setPermissionRequestHandler']>[0]
    ) => {
      installs.permissionRequest += 1;
      requestHandler = handler;
    },
  } as unknown as Electron.Session;

  return {
    check: (requestingUrl, options) => {
      if (checkHandler === null) {
        throw new Error('permission check handler was never installed');
      }
      return checkHandler(webContents, options?.permission ?? 'notifications', '', {
        isMainFrame: options?.isMainFrame ?? false,
        ...(requestingUrl === undefined ? {} : { requestingUrl }),
      });
    },
    downloads: (url) => {
      if (downloadListener === null) {
        throw new Error('will-download listener was never installed');
      }
      let prevented = false;
      downloadListener(
        { defaultPrevented: false, preventDefault: () => (prevented = true) } as Electron.Event,
        { getURL: () => url, getURLChain: () => [url] } as unknown as Electron.DownloadItem
      );
      return prevented;
    },
    installs,
    request: (requestingUrl, options) => {
      if (requestHandler === null) {
        throw new Error('permission request handler was never installed');
      }
      let granted: boolean | undefined;
      requestHandler(
        webContents,
        options?.permission ?? 'notifications',
        (value) => {
          granted = value;
        },
        { isMainFrame: false, requestingUrl: requestingUrl ?? '' }
      );
      if (granted === undefined) {
        throw new Error('permission request handler never answered');
      }
      return granted;
    },
    session,
  };
}

describe('installMcpAppSessionPolicy', () => {
  it('denies MCP App sandbox frames and leaves every other requester granted', () => {
    const captured = fakeSession(MOUNTED_FRAMES);
    installMcpAppSessionPolicy(captured.session);

    expect(captured.request(SHELL)).toBe(false);
    expect(captured.request('about:srcdoc')).toBe(false);
    expect(captured.request(HOST)).toBe(true);

    expect(captured.check(SHELL)).toBe(false);
    expect(captured.check('about:srcdoc')).toBe(false);
    expect(captured.check(HOST, { isMainFrame: true })).toBe(true);
  });

  it('denies an unattributable sub-frame permission CHECK', () => {
    // The one handler whose attribution field Electron types as optional must
    // not be the one that silently grants: APIs that check before requesting
    // never reach the request handler.
    const captured = fakeSession(MOUNTED_FRAMES);
    installMcpAppSessionPolicy(captured.session);

    expect(captured.check(undefined)).toBe(false);
    expect(captured.check(undefined, { isMainFrame: true })).toBe(true);
  });

  it('logs each denial once per WebContents, arm and permission', () => {
    // The handlers are driven by untrusted content in a tight loop, so the
    // denial warn must not be an unbounded on-disk log writer.
    const captured = fakeSession(MOUNTED_FRAMES);
    installMcpAppSessionPolicy(captured.session);

    for (let index = 0; index < 50; index += 1) {
      expect(captured.check(SHELL)).toBe(false);
      expect(captured.request(SHELL)).toBe(false);
    }
    expect(warn).toHaveBeenCalledTimes(2);

    // A distinct permission is still worth its own first line.
    expect(captured.check(SHELL, { permission: 'geolocation' })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('cancels downloads from a shell origin and passes every other download through', () => {
    const captured = fakeSession(MOUNTED_FRAMES);
    installMcpAppSessionPolicy(captured.session);

    expect(captured.downloads(`blob:${SHELL}uuid`)).toBe(true);
    expect(captured.downloads('blob:file:///uuid')).toBe(false);
    expect(captured.downloads('https://example.test/report.pdf')).toBe(false);
  });

  it('is idempotent per session', () => {
    const captured = fakeSession(MOUNTED_FRAMES);
    installMcpAppSessionPolicy(captured.session);
    installMcpAppSessionPolicy(captured.session);

    expect(captured.installs).toEqual({
      permissionCheck: 1,
      permissionRequest: 1,
      willDownload: 1,
    });
  });
});
