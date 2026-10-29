import { describe, expect, it } from 'vitest';
import {
  CANVAS_FRAME_MESSAGE_TYPES,
  CANVAS_RELAY_BUDGET,
  CANVAS_RELAY_MAX_TEXT,
  getCanvasSandboxContentSecurityPolicy,
  isCanvasFrameInboundMessage,
  renderCanvasFrameShellHtml,
} from '../canvas-sandbox.js';

/**
 * Golden contract for the Canvas sandbox (BST-1173).
 *
 * The canvas renders UNTRUSTED assistant-generated HTML/JS. Its entire security
 * model is: (1) the outer iframe is sandboxed WITHOUT `allow-same-origin`, so
 * the shell runs in an opaque origin; (2) the shell document carries this
 * policy, which the nested `srcdoc` document INHERITS (CSP local-scheme
 * inheritance), so canvas content gets inline execution but zero network.
 * Every directive below is load-bearing — do not loosen without a security
 * review.
 */
const CANVAS_SANDBOX_CSP =
  "base-uri 'none'; " +
  "default-src 'none'; " +
  'font-src data:; ' +
  "form-action 'none'; " +
  'img-src data: blob:; ' +
  "object-src 'none'; " +
  "script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'";

describe('getCanvasSandboxContentSecurityPolicy', () => {
  it('matches the reviewed canvas sandbox policy byte-for-byte', () => {
    expect(getCanvasSandboxContentSecurityPolicy()).toBe(CANVAS_SANDBOX_CSP);
  });

  it('denies all network access (no connect-src, default-src none, no remote origins)', () => {
    const csp = getCanvasSandboxContentSecurityPolicy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('connect-src');
    expect(csp).not.toContain('http://');
    expect(csp).not.toContain('https://');
    expect(csp).not.toContain('ws://');
  });

  it("never grants 'self', eval, or worker/frame capabilities to canvas content", () => {
    const csp = getCanvasSandboxContentSecurityPolicy();
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('worker-src');
    expect(csp).not.toContain('frame-src');
  });

  it('omits frame-ancestors: the shell must stay embeddable, and meta CSP ignores it anyway', () => {
    expect(getCanvasSandboxContentSecurityPolicy()).not.toContain('frame-ancestors');
  });
});

describe('renderCanvasFrameShellHtml', () => {
  const shell = renderCanvasFrameShellHtml();

  it('embeds the canvas sandbox CSP as a parse-time meta tag, byte-identical to the header policy', () => {
    expect(shell).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${getCanvasSandboxContentSecurityPolicy()}" />`
    );
  });

  it('references no external resources of any scheme', () => {
    // The shell must be fully self-contained: any URL reference would be both a
    // CSP violation at runtime and a supply-chain surface.
    expect(shell).not.toMatch(/src="(?!data:)[^"]*:\/\//u);
    expect(shell).not.toMatch(/href=/u);
    expect(shell).not.toMatch(/https?:\/\//u);
  });

  it('creates the inner content frame sandboxed with allow-scripts only', () => {
    // The inner iframe is created by the bootstrap script; the sandbox token
    // list must be exactly allow-scripts (no allow-same-origin, no forms, no
    // popups, no top-navigation).
    expect(shell).toContain("setAttribute('sandbox', 'allow-scripts')");
    expect(shell).not.toContain('allow-same-origin');
    expect(shell).not.toContain('allow-popups');
    expect(shell).not.toContain('allow-forms');
    expect(shell).not.toContain('allow-top-navigation');
  });

  it('only accepts render commands from its parent window', () => {
    expect(shell).toContain('event.source === window.parent');
  });

  it('relays only from the inner frame, rebuilding validated messages (never forwarding attacker objects)', () => {
    // The relay branch is the enforcement point against the untrusted realm:
    // source-checked to the inner frame, exact-type validated (a forged
    // brainstrike-canvas:ready must never be forwarded with the shell nonce),
    // text clamped in THIS trusted realm, and budgeted per rendered document.
    expect(shell).toContain('event.source === inner.contentWindow');
    expect(shell).not.toContain('post(data)');
    expect(shell).toContain('data.text.slice(0, MAX_TEXT)');
    expect(shell).toContain(`const MAX_TEXT = ${CANVAS_RELAY_MAX_TEXT}`);
    expect(shell).toContain(`const MAX_RELAYS = ${CANVAS_RELAY_BUDGET}`);
    expect(shell).toContain('relay budget exhausted');
  });

  it('re-announces readiness until the first render command arrives', () => {
    // The host attaches its listener in a React effect; the desktop shell is
    // served from an in-memory protocol response and can parse first. A
    // one-shot READY would race and leave the pane permanently blank.
    expect(shell).toContain('hasReceivedRender');
    expect(shell).toContain('setInterval');
  });

  it('is deterministic (static shell, no per-render state)', () => {
    expect(renderCanvasFrameShellHtml()).toBe(shell);
  });
});

describe('isCanvasFrameInboundMessage', () => {
  const NONCE = 'test-nonce-123';

  it('accepts a valid ready message carrying the expected nonce', () => {
    expect(
      isCanvasFrameInboundMessage({ nonce: NONCE, type: CANVAS_FRAME_MESSAGE_TYPES.ready }, NONCE)
    ).toBe(true);
  });

  it('accepts valid console and error relay messages', () => {
    expect(
      isCanvasFrameInboundMessage(
        {
          level: 'warn',
          nonce: NONCE,
          text: 'hello',
          type: CANVAS_FRAME_MESSAGE_TYPES.relayConsole,
        },
        NONCE
      )
    ).toBe(true);
    expect(
      isCanvasFrameInboundMessage(
        { nonce: NONCE, text: 'boom', type: CANVAS_FRAME_MESSAGE_TYPES.relayError },
        NONCE
      )
    ).toBe(true);
  });

  it('rejects messages with a missing or wrong nonce', () => {
    expect(isCanvasFrameInboundMessage({ type: CANVAS_FRAME_MESSAGE_TYPES.ready }, NONCE)).toBe(
      false
    );
    expect(
      isCanvasFrameInboundMessage(
        { nonce: 'forged', type: CANVAS_FRAME_MESSAGE_TYPES.ready },
        NONCE
      )
    ).toBe(false);
  });

  it('rejects unknown types, non-objects, and malformed relay payloads', () => {
    expect(isCanvasFrameInboundMessage(null, NONCE)).toBe(false);
    expect(isCanvasFrameInboundMessage('ready', NONCE)).toBe(false);
    expect(isCanvasFrameInboundMessage({ nonce: NONCE, type: 'evil' }, NONCE)).toBe(false);
    expect(
      isCanvasFrameInboundMessage(
        { level: 'nope', nonce: NONCE, text: 'x', type: CANVAS_FRAME_MESSAGE_TYPES.relayConsole },
        NONCE
      )
    ).toBe(false);
    expect(
      isCanvasFrameInboundMessage(
        { nonce: NONCE, text: 42, type: CANVAS_FRAME_MESSAGE_TYPES.relayError },
        NONCE
      )
    ).toBe(false);
  });

  it('rejects relay text exceeding the shell clamp — anything longer is forged or a shell bug', () => {
    const atLimit = 'x'.repeat(CANVAS_RELAY_MAX_TEXT);
    expect(
      isCanvasFrameInboundMessage(
        { nonce: NONCE, text: atLimit, type: CANVAS_FRAME_MESSAGE_TYPES.relayError },
        NONCE
      )
    ).toBe(true);
    expect(
      isCanvasFrameInboundMessage(
        { nonce: NONCE, text: `${atLimit}x`, type: CANVAS_FRAME_MESSAGE_TYPES.relayError },
        NONCE
      )
    ).toBe(false);
    expect(
      isCanvasFrameInboundMessage(
        {
          level: 'log',
          nonce: NONCE,
          text: `${atLimit}x`,
          type: CANVAS_FRAME_MESSAGE_TYPES.relayConsole,
        },
        NONCE
      )
    ).toBe(false);
  });
});
