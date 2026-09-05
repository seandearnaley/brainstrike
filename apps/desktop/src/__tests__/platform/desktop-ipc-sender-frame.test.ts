import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureDesktopIpcSenderFrameAllowlist,
  createDesktopIpcSenderFrameAllowlist,
  isAllowedDesktopIpcSenderFrameUrl,
  resolveDesktopIpcSenderFrameAllowlist,
} from '../../platform/desktop-ipc-sender-frame';

const BUILT_RENDERER_PATH =
  '/Applications/Brainstrike.app/Contents/Resources/app.asar/dist/renderer/index.html';
const BUILT_RENDERER_URL = pathToFileURL(BUILT_RENDERER_PATH).href;
const DEV_RENDERER_URL = 'http://localhost:38181';

describe('desktop IPC sender-frame allowlist', () => {
  afterEach(() => {
    configureDesktopIpcSenderFrameAllowlist(null);
  });

  describe('built renderer (built + test-built launch modes)', () => {
    const allowlist = createDesktopIpcSenderFrameAllowlist({
      builtRendererPath: BUILT_RENDERER_PATH,
      devRendererUrl: DEV_RENDERER_URL,
      launchMode: 'built',
    });

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
      const testBuilt = createDesktopIpcSenderFrameAllowlist({
        builtRendererPath: BUILT_RENDERER_PATH,
        devRendererUrl: DEV_RENDERER_URL,
        launchMode: 'test-built',
      });
      expect(testBuilt).toEqual(allowlist);
    });
  });

  describe('dev-server launch mode', () => {
    const allowlist = createDesktopIpcSenderFrameAllowlist({
      builtRendererPath: BUILT_RENDERER_PATH,
      devRendererUrl: DEV_RENDERER_URL,
      launchMode: 'dev-server',
    });

    it('accepts the dev origin document with or without hidden-host query parameters', () => {
      expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, `${DEV_RENDERER_URL}/`)).toBe(true);
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

    it('honours a configured dev URL that carries a base path', () => {
      const withBase = createDesktopIpcSenderFrameAllowlist({
        builtRendererPath: BUILT_RENDERER_PATH,
        devRendererUrl: 'http://localhost:5173/desktop',
        launchMode: 'dev-server',
      });
      expect(isAllowedDesktopIpcSenderFrameUrl(withBase, 'http://localhost:5173/desktop')).toBe(
        true
      );
      expect(isAllowedDesktopIpcSenderFrameUrl(withBase, 'http://localhost:5173/')).toBe(false);
    });
  });

  it('rejects an unsupported launch mode at construction', () => {
    expect(() =>
      createDesktopIpcSenderFrameAllowlist({
        builtRendererPath: BUILT_RENDERER_PATH,
        devRendererUrl: DEV_RENDERER_URL,
        launchMode: 'remote' as never,
      })
    ).toThrow('Unsupported desktop launch mode "remote"');
  });

  it('fails closed when the process-wide allowlist was never configured', () => {
    expect(() => resolveDesktopIpcSenderFrameAllowlist()).toThrow(
      'Desktop IPC sender-frame allowlist is not configured.'
    );
  });

  it('returns the configured process-wide allowlist', () => {
    const allowlist = createDesktopIpcSenderFrameAllowlist({
      builtRendererPath: BUILT_RENDERER_PATH,
      devRendererUrl: DEV_RENDERER_URL,
      launchMode: 'built',
    });
    configureDesktopIpcSenderFrameAllowlist(allowlist);
    expect(resolveDesktopIpcSenderFrameAllowlist()).toBe(allowlist);
  });
});
