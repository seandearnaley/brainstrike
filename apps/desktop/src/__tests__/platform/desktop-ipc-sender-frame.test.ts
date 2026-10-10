import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureDesktopRendererTarget,
  createDesktopRendererTarget,
} from '../../desktop-renderer-target';
import {
  createDesktopIpcSenderFrameAllowlist,
  isAllowedDesktopIpcSenderFrameUrl,
  resolveDesktopIpcSenderFrameAllowlist,
} from '../../platform/desktop-ipc-sender-frame';

const BUILT_RENDERER_PATH = resolve(
  '/Applications/Brainstrike.app/Contents/Resources/app.asar/dist/renderer/index.html'
);
const BUILT_RENDERER_URL = pathToFileURL(BUILT_RENDERER_PATH).href;
const DEV_RENDERER_URL = 'http://localhost:38181';

function createTarget(
  launchMode: 'built' | 'dev-server' | 'test-built',
  devRendererUrl = DEV_RENDERER_URL
) {
  return createDesktopRendererTarget({
    builtRendererPath: BUILT_RENDERER_PATH,
    devRendererUrl,
    launchMode,
  });
}

describe('desktop IPC sender-frame allowlist', () => {
  afterEach(() => {
    configureDesktopRendererTarget(null);
  });

  describe('built renderer (built + test-built launch modes)', () => {
    const allowlist = createDesktopIpcSenderFrameAllowlist(createTarget('built'));

    it('accepts the visible renderer file URL and hidden-host URLs that only differ by query', () => {
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, BUILT_RENDERER_URL)).toBe(true);
      expect(
        isAllowedDesktopIpcSenderFrameUrl(
          allowlist,
          `${BUILT_RENDERER_URL}?mode=embedding-host&runtimeId=018f-0000`
        )
      ).toBe(true);
      expect(
        isAllowedDesktopIpcSenderFrameUrl(allowlist, `${BUILT_RENDERER_URL}?mode=llm-host#route`)
      ).toBe(true);
    });

    it('rejects sibling files, path-prefix spoofs, the dev server, and foreign origins', () => {
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, `${BUILT_RENDERER_URL}.evil.html`)).toBe(
        false
      );
      expect(
        isAllowedDesktopIpcSenderFrameUrl(
          allowlist,
          pathToFileURL(
            '/Applications/Brainstrike.app/Contents/Resources/app.asar/dist/renderer/other.html'
          ).href
        )
      ).toBe(false);
      expect(
        isAllowedDesktopIpcSenderFrameUrl(allowlist, pathToFileURL('/tmp/renderer/index.html').href)
      ).toBe(false);
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, `${DEV_RENDERER_URL}/`)).toBe(false);
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, 'https://evil.example/index.html')).toBe(
        false
      );
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, 'about:blank')).toBe(false);
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, '')).toBe(false);
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, 'not a url')).toBe(false);
    });

    it('is identical for the test-built launch mode', () => {
      expect(createDesktopIpcSenderFrameAllowlist(createTarget('test-built'))).toEqual(allowlist);
    });
  });

  describe('dev-server launch mode', () => {
    const allowlist = createDesktopIpcSenderFrameAllowlist(createTarget('dev-server'));

    it('accepts the dev origin document with or without hidden-host query parameters', () => {
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, `${DEV_RENDERER_URL}/`)).toBe(true);
      // The exact string `renderer-host-lifecycle.ts` loads in dev: the
      // configured URL (no trailing slash) plus the role query.
      expect(
        isAllowedDesktopIpcSenderFrameUrl(
          allowlist,
          `${DEV_RENDERER_URL}?mode=chunking-host&runtimeId=018f-0001`
        )
      ).toBe(true);
      expect(
        isAllowedDesktopIpcSenderFrameUrl(
          allowlist,
          `${DEV_RENDERER_URL}/?mode=chunking-host&runtimeId=018f-0001`
        )
      ).toBe(true);
    });

    it('rejects other paths on the dev origin, other ports, and the built file URL', () => {
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, `${DEV_RENDERER_URL}/index.html`)).toBe(
        false
      );
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, `${DEV_RENDERER_URL}/evil`)).toBe(false);
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, 'http://localhost:38182/')).toBe(false);
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, 'http://127.0.0.1:38181/')).toBe(false);
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, BUILT_RENDERER_URL)).toBe(false);
    });

    it('treats a configured base path with and without a trailing slash as the same document', () => {
      const withBase = createDesktopIpcSenderFrameAllowlist(
        createTarget('dev-server', 'http://localhost:5173/desktop')
      );
      expect(withBase).toEqual({
        kind: 'dev-renderer',
        origin: 'http://localhost:5173',
        pathname: '/desktop',
      });
      expect(isAllowedDesktopIpcSenderFrameUrl(withBase, 'http://localhost:5173/desktop')).toBe(
        true
      );
      // Vite redirects `/desktop` to `/desktop/` when the base carries a slash.
      expect(isAllowedDesktopIpcSenderFrameUrl(withBase, 'http://localhost:5173/desktop/')).toBe(
        true
      );
      expect(
        isAllowedDesktopIpcSenderFrameUrl(withBase, 'http://localhost:5173/desktop/?mode=llm-host')
      ).toBe(true);
      const withTrailingSlash = createDesktopIpcSenderFrameAllowlist(
        createTarget('dev-server', 'http://localhost:5173/desktop/')
      );
      expect(withTrailingSlash).toEqual(withBase);
    });

    it('keeps the base-path comparison an equality, not a prefix match', () => {
      const withBase = createDesktopIpcSenderFrameAllowlist(
        createTarget('dev-server', 'http://localhost:5173/desktop')
      );
      expect(isAllowedDesktopIpcSenderFrameUrl(withBase, 'http://localhost:5173/')).toBe(false);
      expect(
        isAllowedDesktopIpcSenderFrameUrl(withBase, 'http://localhost:5173/desktop/index.html')
      ).toBe(false);
      expect(
        isAllowedDesktopIpcSenderFrameUrl(withBase, 'http://localhost:5173/desktop-evil')
      ).toBe(false);
      expect(isAllowedDesktopIpcSenderFrameUrl(withBase, 'http://localhost:5173/desktopx/')).toBe(
        false
      );
    });
  });

  it('fails closed when no renderer target was configured process-wide', () => {
    expect(() => resolveDesktopIpcSenderFrameAllowlist()).toThrow(
      'Desktop renderer target is not configured.'
    );
  });

  it('derives the process-wide allowlist from the configured renderer target and caches it per target', () => {
    const target = createTarget('built');
    configureDesktopRendererTarget(target);
    const first = resolveDesktopIpcSenderFrameAllowlist();
    expect(first).toEqual(createDesktopIpcSenderFrameAllowlist(target));
    expect(resolveDesktopIpcSenderFrameAllowlist()).toBe(first);

    const devTarget = createTarget('dev-server');
    configureDesktopRendererTarget(devTarget);
    expect(resolveDesktopIpcSenderFrameAllowlist()).toEqual(
      createDesktopIpcSenderFrameAllowlist(devTarget)
    );
  });
});
