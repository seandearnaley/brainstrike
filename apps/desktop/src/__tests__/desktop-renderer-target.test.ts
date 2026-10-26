import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureDesktopRendererTarget,
  createDesktopRendererTarget,
  type DesktopRendererTarget,
  rendererDocumentUrl,
  resolveDesktopRendererTarget,
} from '../desktop-renderer-target';
import {
  createDesktopIpcSenderFrameAllowlist,
  isAllowedDesktopIpcSenderFrameUrl,
} from '../platform/desktop-ipc-sender-frame';
import { TEST_DESKTOP_RENDERER_TARGET } from './helpers/desktop-ipc-sender-frame-test-allowlist';

const BUILT_RENDERER_PATH = resolve('/opt/brainstrike/dist/renderer/index.html');
const DEV_RENDERER_URL = 'http://localhost:38181';

/**
 * The document URL a window ends up on for `target`, spelled the way the
 * loader spells it: `create-window.ts` → `loadFile(rendererPath)` /
 * `loadURL(url)`.
 */
function loadedDocumentUrl(target: DesktopRendererTarget): string {
  return target.kind === 'built-renderer' ? rendererDocumentUrl(target) : target.url;
}

describe('desktop renderer target', () => {
  afterEach(() => {
    configureDesktopRendererTarget(TEST_DESKTOP_RENDERER_TARGET);
  });

  it('maps built and test-built launch modes to the normalized built renderer file', () => {
    expect(
      createDesktopRendererTarget({
        builtRendererPath: `${resolve('/opt/brainstrike')}/dist/./renderer/index.html`,
        devRendererUrl: DEV_RENDERER_URL,
        launchMode: 'built',
      })
    ).toEqual({ kind: 'built-renderer', launchMode: 'built', rendererPath: BUILT_RENDERER_PATH });
    expect(
      createDesktopRendererTarget({
        builtRendererPath: BUILT_RENDERER_PATH,
        devRendererUrl: DEV_RENDERER_URL,
        launchMode: 'test-built',
      })
    ).toEqual({
      kind: 'built-renderer',
      launchMode: 'test-built',
      rendererPath: BUILT_RENDERER_PATH,
    });
  });

  it('maps the dev-server launch mode to the configured dev URL verbatim', () => {
    expect(
      createDesktopRendererTarget({
        builtRendererPath: BUILT_RENDERER_PATH,
        devRendererUrl: DEV_RENDERER_URL,
        launchMode: 'dev-server',
      })
    ).toEqual({ kind: 'dev-renderer', launchMode: 'dev-server', url: DEV_RENDERER_URL });
  });

  it('rejects a malformed dev URL and an unsupported launch mode at construction', () => {
    expect(() =>
      createDesktopRendererTarget({
        builtRendererPath: BUILT_RENDERER_PATH,
        devRendererUrl: 'not a url',
        launchMode: 'dev-server',
      })
    ).toThrow();
    expect(() =>
      createDesktopRendererTarget({
        builtRendererPath: BUILT_RENDERER_PATH,
        devRendererUrl: DEV_RENDERER_URL,
        launchMode: 'remote' as never,
      })
    ).toThrow('Unsupported desktop launch mode "remote"');
  });

  it('fails closed until main.ts configures it, then returns the configured object', () => {
    configureDesktopRendererTarget(null);
    expect(() => resolveDesktopRendererTarget()).toThrow(
      'Desktop renderer target is not configured.'
    );
    const target = createDesktopRendererTarget({
      builtRendererPath: BUILT_RENDERER_PATH,
      devRendererUrl: DEV_RENDERER_URL,
      launchMode: 'built',
    });
    configureDesktopRendererTarget(target);
    expect(resolveDesktopRendererTarget()).toBe(target);
  });

  // BST-1641 review: the allowlist and the loader share this ONE object, so
  // for every launch mode the document a window is loaded on is, by
  // construction, on the allowlist derived from the same target.
  describe.each(['built', 'test-built', 'dev-server'] as const)(
    'the %s target agrees with its derived sender-frame allowlist',
    (launchMode) => {
      const target = createDesktopRendererTarget({
        builtRendererPath: BUILT_RENDERER_PATH,
        devRendererUrl: DEV_RENDERER_URL,
        launchMode,
      });
      const allowlist = createDesktopIpcSenderFrameAllowlist(target);

      it('accepts the document the app window loads', () => {
        expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, loadedDocumentUrl(target))).toBe(true);
      });

      it('rejects the document the OTHER launch mode would have loaded', () => {
        const other = createDesktopRendererTarget({
          builtRendererPath: BUILT_RENDERER_PATH,
          devRendererUrl: DEV_RENDERER_URL,
          launchMode: launchMode === 'dev-server' ? 'built' : 'dev-server',
        });
        expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, loadedDocumentUrl(other))).toBe(false);
      });
    }
  );
});
