import { renderCanvasFrameShellHtml } from '@brainstrike/platform-utils';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CanvasFrame } from './canvas-frame';

/**
 * REAL-BROWSER acceptance tests for the Canvas sandbox (BST-1173).
 *
 * These run in actual Chromium (Vitest browser mode) so they exercise the real
 * security machinery: iframe sandbox flags, CSP meta enforcement, and
 * cross-origin isolation. They are the proof behind the ticket's acceptance
 * criteria — untrusted canvas JS runs, but cannot reach the network, the
 * parent DOM, or persistent storage.
 *
 * The shell is served from a blob: URL here. In production it is served by the
 * brainstrike-canvas: protocol (desktop) or /canvas-frame.html (web); the blob
 * carrier changes nothing about the sandbox semantics under test because the
 * outer iframe is sandboxed without allow-same-origin either way.
 */

let shellUrl: string;
let consoleEvents: Array<{ level: string; text: string }>;
let errorEvents: Array<{ text: string }>;

beforeEach(() => {
  shellUrl = URL.createObjectURL(new Blob([renderCanvasFrameShellHtml()], { type: 'text/html' }));
  consoleEvents = [];
  errorEvents = [];
});

afterEach(() => {
  URL.revokeObjectURL(shellUrl);
});

function mount(html: string) {
  return render(
    <CanvasFrame
      html={html}
      onConsoleEvent={(event) => consoleEvents.push(event)}
      onErrorEvent={(event) => errorEvents.push(event)}
      shellSrc={shellUrl}
      theme="light"
    />
  );
}

async function waitForConsoleText(text: string): Promise<void> {
  await waitFor(
    () => {
      expect(consoleEvents.map((event) => event.text)).toContain(text);
    },
    { timeout: 10_000 }
  );
}

describe('CanvasFrame in a real browser', () => {
  it('executes untrusted inline scripts and relays their console output', async () => {
    mount('<p>hello</p><script>console.log("CANVAS_ALIVE")</script>');
    await waitForConsoleText('CANVAS_ALIVE');
  });

  it('blocks all network access from canvas content (CSP default-src none)', async () => {
    mount(
      '<script>fetch("https://example.com/").then(() => console.log("FETCH_OK")).catch(() => console.log("FETCH_BLOCKED"))</script>'
    );
    await waitForConsoleText('FETCH_BLOCKED');
    expect(consoleEvents.map((event) => event.text)).not.toContain('FETCH_OK');
  });

  it('denies canvas content access to the host DOM and persistent storage', async () => {
    mount(
      `<script>
        try { void window.top.document; console.log("DOM_OK"); }
        catch { console.log("DOM_BLOCKED"); }
        try { window.localStorage.setItem("x", "1"); console.log("STORAGE_OK"); }
        catch { console.log("STORAGE_BLOCKED"); }
      </script>`
    );
    await waitForConsoleText('DOM_BLOCKED');
    await waitForConsoleText('STORAGE_BLOCKED');
    const texts = consoleEvents.map((event) => event.text);
    expect(texts).not.toContain('DOM_OK');
    expect(texts).not.toContain('STORAGE_OK');
  });

  it('relays uncaught canvas errors to the host', async () => {
    mount('<script>throw new Error("canvas exploded")</script>');
    await waitFor(
      () => {
        expect(errorEvents.some((event) => event.text.includes('canvas exploded'))).toBe(true);
      },
      { timeout: 10_000 }
    );
  });

  it('clamps oversized relay text even when canvas content bypasses the prelude', async () => {
    // Post straight to the shell (window.parent), skipping the prelude's own
    // clamp — the TRUSTED shell must rebuild and clamp before forwarding.
    mount(
      '<script>window.parent.postMessage({ type: "brainstrike-canvas:relay:console", level: "log", text: "y".repeat(50000) }, "*"); console.log("SENT_HUGE");</script>'
    );
    await waitForConsoleText('SENT_HUGE');
    const huge = consoleEvents.find((event) => event.text.startsWith('yyy'));
    expect(huge).toBeDefined();
    expect(huge?.text.length).toBeLessThanOrEqual(8000);
  });

  it('never forwards a forged ready message from canvas content (no render loop)', async () => {
    mount(
      '<script>console.log("BOOTED"); window.parent.postMessage({ type: "brainstrike-canvas:ready" }, "*"); window.parent.postMessage({ type: "brainstrike-canvas:render", html: "<p>evil</p>" }, "*");</script>'
    );
    await waitForConsoleText('BOOTED');
    // A forged ready forwarded with the shell nonce would make the host
    // re-send the render command and re-execute the document. Give any such
    // loop time to happen, then require exactly one boot.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(consoleEvents.filter((event) => event.text === 'BOOTED')).toHaveLength(1);
  });

  it('re-renders replaced content cleanly (version switching)', async () => {
    const { rerender } = mount('<script>console.log("VERSION_1")</script>');
    await waitForConsoleText('VERSION_1');
    rerender(
      <CanvasFrame
        html={'<script>console.log("VERSION_2")</script>'}
        onConsoleEvent={(event) => consoleEvents.push(event)}
        onErrorEvent={(event) => errorEvents.push(event)}
        shellSrc={shellUrl}
        theme="light"
      />
    );
    await waitForConsoleText('VERSION_2');
  });
});
