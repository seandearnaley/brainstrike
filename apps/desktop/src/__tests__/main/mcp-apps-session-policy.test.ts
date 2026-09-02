import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

import {
  installMcpAppSessionPolicy,
  isMcpAppSandboxDownload,
  isMcpAppSandboxPermissionRequest,
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

describe('isMcpAppSandboxPermissionRequest', () => {
  it('denies the shell frame by its own origin', () => {
    expect(isMcpAppSandboxPermissionRequest({ frames: MOUNTED_FRAMES, requestingUrl: SHELL })).toBe(
      true
    );
    // Even with nothing else in the tree to corroborate it.
    expect(isMcpAppSandboxPermissionRequest({ frames: [], requestingUrl: SHELL })).toBe(true);
  });

  it('denies the opaque about:srcdoc app frame via its shell parent', () => {
    expect(
      isMcpAppSandboxPermissionRequest({ frames: MOUNTED_FRAMES, requestingUrl: 'about:srcdoc' })
    ).toBe(true);
  });

  it('never denies the host renderer', () => {
    for (const frames of [MOUNTED_FRAMES, CANVAS_ONLY_FRAMES, []]) {
      expect(isMcpAppSandboxPermissionRequest({ frames, requestingUrl: HOST })).toBe(false);
      expect(
        isMcpAppSandboxPermissionRequest({
          frames,
          requestingUrl: 'http://localhost:5173/index.html',
        })
      ).toBe(false);
    }
  });

  it('leaves srcdoc frames alone when no MCP App shell is mounted', () => {
    expect(
      isMcpAppSandboxPermissionRequest({
        frames: CANVAS_ONLY_FRAMES,
        requestingUrl: 'about:srcdoc',
      })
    ).toBe(false);
  });

  it('treats an unattributable requester as not an MCP App frame', () => {
    expect(
      isMcpAppSandboxPermissionRequest({ frames: MOUNTED_FRAMES, requestingUrl: undefined })
    ).toBe(false);
    expect(isMcpAppSandboxPermissionRequest({ frames: MOUNTED_FRAMES, requestingUrl: '' })).toBe(
      false
    );
  });

  it('does not match a look-alike scheme prefix', () => {
    expect(
      isMcpAppSandboxPermissionRequest({
        frames: MOUNTED_FRAMES,
        requestingUrl: 'brainstrike-mcp-apple://evil/',
      })
    ).toBe(false);
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
});

interface CapturedSession {
  readonly check: (requestingUrl: string | undefined) => boolean;
  readonly downloads: (url: string) => boolean;
  readonly installs: { permissionRequest: number; permissionCheck: number; willDownload: number };
  readonly request: (requestingUrl: string | undefined) => boolean;
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
    check: (requestingUrl) => {
      if (checkHandler === null) {
        throw new Error('permission check handler was never installed');
      }
      return checkHandler(webContents, 'notifications', '', {
        isMainFrame: false,
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
    request: (requestingUrl) => {
      if (requestHandler === null) {
        throw new Error('permission request handler was never installed');
      }
      let granted: boolean | undefined;
      requestHandler(
        webContents,
        'notifications',
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
    expect(captured.check(HOST)).toBe(true);
    expect(captured.check(undefined)).toBe(true);
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
