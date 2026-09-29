import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureDesktopRendererTarget,
  createDesktopRendererTarget,
  type DesktopRendererTarget,
  resolveDesktopRendererTarget,
} from '../desktop-renderer-target';
import {
  createDesktopIpcSenderFrameAllowlist,
  isAllowedDesktopIpcSenderFrameUrl,
} from '../platform/desktop-ipc-sender-frame';
import type { DesktopWindowRole } from '../window-role';
import { TEST_DESKTOP_RENDERER_TARGET } from './helpers/desktop-ipc-sender-frame-test-allowlist';

const BUILT_RENDERER_PATH = '/opt/brainstrike/dist/renderer/index.html';
const DEV_RENDERER_URL = 'http://localhost:38181';

/**
 * The document URL a window ends up on for `target`, spelled the way the
 * loaders spell it: `create-window.ts` → `loadFile(rendererPath)` /
 * `loadURL(url)`; `renderer-host-lifecycle.ts` → the same plus
 * `?mode=<role>&runtimeId=…` (`loadFile`'s `query` option for the built
 * file, string concatenation for the dev URL).
 */
function loadedDocumentUrl(target: DesktopRendererTarget, role: DesktopWindowRole): string {
  const query = role === 'visible-ui' ? '' : `?mode=${role}&runtimeId=${role}%3A018f-0000`;
  if (target.kind === 'built-renderer') {
    return `${pathToFileURL(target.rendererPath).href}${query}`;
  }
  return `${target.url}${query}`;
}

const ROLES: readonly DesktopWindowRole[] = [
  'visible-ui',
  'chunking-host',
  'embedding-host',
  'llm-host',
];

describe('desktop renderer target', () => {
  afterEach(() => {
    configureDesktopRendererTarget(TEST_DESKTOP_RENDERER_TARGET);
  });

  it('maps built and test-built launch modes to the normalized built renderer file', () => {
    expect(
      createDesktopRendererTarget({
        builtRendererPath: '/opt/brainstrike/dist/./renderer/index.html',
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

  // BST-1641 review: the allowlist and the loaders share this ONE object, so
  // for every launch mode the document a window is loaded on is, by
  // construction, on the allowlist derived from the same target — for the
  // visible window and for each hidden host's query-suffixed variant.
  describe.each(['built', 'test-built', 'dev-server'] as const)(
    'the %s target agrees with its derived sender-frame allowlist',
    (launchMode) => {
      const target = createDesktopRendererTarget({
        builtRendererPath: BUILT_RENDERER_PATH,
        devRendererUrl: DEV_RENDERER_URL,
        launchMode,
      });
      const allowlist = createDesktopIpcSenderFrameAllowlist(target);

      it.each(ROLES)('accepts the document the %s window loads', (role) => {
        expect(isAllowedDesktopIpcSenderFrameUrl(allowlist, loadedDocumentUrl(target, role))).toBe(
          true
        );
      });

      it('rejects the document the OTHER launch mode would have loaded', () => {
        const other = createDesktopRendererTarget({
          builtRendererPath: BUILT_RENDERER_PATH,
          devRendererUrl: DEV_RENDERER_URL,
          launchMode: launchMode === 'dev-server' ? 'built' : 'dev-server',
        });
        expect(
          isAllowedDesktopIpcSenderFrameUrl(allowlist, loadedDocumentUrl(other, 'visible-ui'))
        ).toBe(false);
      });
    }
  );
});
