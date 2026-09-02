import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

import { shouldDenyMcpAppFrameNavigation } from '../../mcp/apps-frame-navigation';

const SHELL = `brainstrike-mcp-app://${'a'.repeat(32)}/`;
const HOST =
  'file:///Applications/BrainStrike.app/Contents/Resources/app.asar/dist/renderer/index.html';

describe('shouldDenyMcpAppFrameNavigation', () => {
  it('lets the host frame load a shell and the shell load its srcdoc app frame', () => {
    expect(
      shouldDenyMcpAppFrameNavigation({
        frameUrl: 'about:blank',
        isMainFrame: false,
        parentUrl: HOST,
        targetUrl: SHELL,
      })
    ).toBe(false);
    expect(
      shouldDenyMcpAppFrameNavigation({
        frameUrl: 'about:blank',
        isMainFrame: false,
        parentUrl: SHELL,
        targetUrl: 'about:srcdoc',
      })
    ).toBe(false);
  });

  it('never lets the shell frame navigate away', () => {
    for (const targetUrl of ['about:blank', 'https://escape.invalid/', SHELL, HOST]) {
      expect(
        shouldDenyMcpAppFrameNavigation({
          frameUrl: SHELL,
          isMainFrame: false,
          parentUrl: HOST,
          targetUrl,
        })
      ).toBe(true);
    }
  });

  it('denies the app frame every navigation except its own srcdoc document', () => {
    for (const targetUrl of ['https://escape.invalid/', 'about:blank', HOST, 'data:text/html,x']) {
      expect(
        shouldDenyMcpAppFrameNavigation({
          frameUrl: 'about:srcdoc',
          isMainFrame: false,
          parentUrl: SHELL,
          targetUrl,
        })
      ).toBe(true);
    }
  });

  it('leaves main-frame navigation, canvas frames, and app-embedded frames alone', () => {
    expect(
      shouldDenyMcpAppFrameNavigation({
        frameUrl: HOST,
        isMainFrame: true,
        parentUrl: undefined,
        targetUrl: 'https://escape.invalid/',
      })
    ).toBe(false);
    expect(
      shouldDenyMcpAppFrameNavigation({
        frameUrl: 'about:srcdoc',
        isMainFrame: false,
        parentUrl: 'brainstrike-canvas://shell/',
        targetUrl: 'https://example.com/',
      })
    ).toBe(false);
    // A frame the app embeds under its declared frameDomains has the app
    // frame (about:srcdoc), not the shell, as its parent.
    expect(
      shouldDenyMcpAppFrameNavigation({
        frameUrl: 'about:blank',
        isMainFrame: false,
        parentUrl: 'about:srcdoc',
        targetUrl: 'https://frame.example.com/',
      })
    ).toBe(false);
  });
});
