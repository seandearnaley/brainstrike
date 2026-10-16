// @vitest-environment-options {"settings":{"enableIframePageLoading":true}}

import { CANVAS_FRAME_MESSAGE_TYPES } from '@brainstrike/platform-utils';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CanvasFrame } from '../canvas-frame';

// Happy DOM 21 requires an explicit iframe opt-in. Only this suite needs a
// browsing context for message-source identity; about:blank loads no remote shell.
const SHELL_SRC = 'about:blank';

function getFrame(): HTMLIFrameElement {
  return screen.getByTitle<HTMLIFrameElement>('Canvas');
}

/**
 * Read the per-mount nonce back out of the iframe src. The nonce travels in the
 * URL FRAGMENT (never the query): fragments are readable by the shell script
 * but are not sent to the server, keep the static shell cacheable under one
 * key, and remain legal on blob: URLs (queries are not).
 */
function nonceOf(frame: HTMLIFrameElement): string {
  const nonce = new URLSearchParams(new URL(frame.src).hash.slice(1)).get('nonce');
  if (!nonce) {
    throw new Error(`iframe src carries no fragment nonce: ${frame.src}`);
  }
  return nonce;
}

function dispatchFrameMessage(source: Window | null, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
}

describe('CanvasFrame', () => {
  it('renders a sandboxed iframe: allow-scripts ONLY, no allow-same-origin, no referrer', () => {
    render(<CanvasFrame html="<p>hi</p>" shellSrc={SHELL_SRC} theme="light" />);
    const frame = getFrame();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('srcdoc')).toBeNull();
    expect(frame.src.startsWith(SHELL_SRC)).toBe(true);
  });

  it('mints a fresh nonce per mount and appends it to the shell URL', () => {
    const first = render(<CanvasFrame html="<p>a</p>" shellSrc={SHELL_SRC} theme="light" />);
    const firstNonce = nonceOf(getFrame());
    first.unmount();
    render(<CanvasFrame html="<p>b</p>" shellSrc={SHELL_SRC} theme="light" />);
    expect(nonceOf(getFrame())).not.toBe(firstNonce);
  });

  it('sends the render command only after the shell signals ready with the right nonce', async () => {
    render(<CanvasFrame html="<p>hi</p>" shellSrc={SHELL_SRC} theme="dark" />);
    const frame = getFrame();
    const contentWindow = frame.contentWindow;
    if (!contentWindow) {
      throw new Error('happy-dom iframe has no contentWindow');
    }
    const postMessage = vi.spyOn(contentWindow, 'postMessage');

    // Wrong nonce → no render.
    dispatchFrameMessage(contentWindow, {
      nonce: 'forged',
      type: CANVAS_FRAME_MESSAGE_TYPES.ready,
    });
    expect(postMessage).not.toHaveBeenCalled();

    dispatchFrameMessage(contentWindow, {
      nonce: nonceOf(frame),
      type: CANVAS_FRAME_MESSAGE_TYPES.ready,
    });
    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          html: '<p>hi</p>',
          theme: 'dark',
          type: CANVAS_FRAME_MESSAGE_TYPES.render,
        }),
        '*'
      );
    });
  });

  it('relays console/error events from the shell and ignores foreign or forged sources', async () => {
    const onConsoleEvent = vi.fn();
    const onErrorEvent = vi.fn();
    render(
      <CanvasFrame
        html="<p>hi</p>"
        onConsoleEvent={onConsoleEvent}
        onErrorEvent={onErrorEvent}
        shellSrc={SHELL_SRC}
        theme="light"
      />
    );
    const frame = getFrame();
    const nonce = nonceOf(frame);

    // Foreign source (not the iframe's contentWindow) is ignored even with a
    // valid-shaped payload and correct nonce.
    dispatchFrameMessage(window, {
      level: 'log',
      nonce,
      text: 'spoofed',
      type: CANVAS_FRAME_MESSAGE_TYPES.relayConsole,
    });
    // Correct source, wrong nonce is ignored.
    dispatchFrameMessage(frame.contentWindow, {
      level: 'log',
      nonce: 'forged',
      text: 'forged',
      type: CANVAS_FRAME_MESSAGE_TYPES.relayConsole,
    });
    expect(onConsoleEvent).not.toHaveBeenCalled();

    dispatchFrameMessage(frame.contentWindow, {
      level: 'warn',
      nonce,
      text: 'careful',
      type: CANVAS_FRAME_MESSAGE_TYPES.relayConsole,
    });
    dispatchFrameMessage(frame.contentWindow, {
      nonce,
      text: 'kaboom',
      type: CANVAS_FRAME_MESSAGE_TYPES.relayError,
    });
    await waitFor(() => {
      expect(onConsoleEvent).toHaveBeenCalledWith({ level: 'warn', text: 'careful' });
      expect(onErrorEvent).toHaveBeenCalledWith({ text: 'kaboom' });
    });
  });

  it('reports a bounded handshake failure when the shell never becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const onShellTimeout = vi.fn();
      render(
        <CanvasFrame
          html="<p>hi</p>"
          onShellTimeout={onShellTimeout}
          shellReadyTimeoutMs={5000}
          shellSrc={SHELL_SRC}
          theme="light"
        />
      );
      vi.advanceTimersByTime(4999);
      expect(onShellTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(onShellTimeout).toHaveBeenCalledWith({
        shellSrc: SHELL_SRC,
        timeoutMs: 5000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the handshake timeout once the shell announces ready, and reports recovery', async () => {
    vi.useFakeTimers();
    try {
      const onShellReady = vi.fn();
      const onShellTimeout = vi.fn();
      render(
        <CanvasFrame
          html="<p>hi</p>"
          onShellReady={onShellReady}
          onShellTimeout={onShellTimeout}
          shellReadyTimeoutMs={5000}
          shellSrc={SHELL_SRC}
          theme="light"
        />
      );
      const frame = getFrame();
      // act(): the ready handler's state update must commit (and the timeout
      // effect's cleanup must run) before the clock advances.
      act(() => {
        dispatchFrameMessage(frame.contentWindow, {
          nonce: nonceOf(frame),
          type: CANVAS_FRAME_MESSAGE_TYPES.ready,
        });
      });
      vi.advanceTimersByTime(20_000);
      expect(onShellTimeout).not.toHaveBeenCalled();
      // Consumers clear their timeout banner on this signal — it must fire on
      // EVERY ready, including a late one after a timeout already reported.
      expect(onShellReady).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-sends the current content when the shell re-announces ready (frame reload)', async () => {
    const { rerender } = render(
      <CanvasFrame html="<p>v1</p>" shellSrc={SHELL_SRC} theme="light" />
    );
    const frame = getFrame();
    const contentWindow = frame.contentWindow;
    if (!contentWindow) {
      throw new Error('happy-dom iframe has no contentWindow');
    }
    const postMessage = vi.spyOn(contentWindow, 'postMessage');
    const nonce = nonceOf(frame);

    dispatchFrameMessage(contentWindow, { nonce, type: CANVAS_FRAME_MESSAGE_TYPES.ready });
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));

    rerender(<CanvasFrame html="<p>v2</p>" shellSrc={SHELL_SRC} theme="light" />);
    await waitFor(() =>
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ html: '<p>v2</p>' }),
        '*'
      )
    );

    // Shell reloads (e.g. renderer recovery) → announces ready again → current
    // content must be replayed, not lost.
    dispatchFrameMessage(contentWindow, { nonce, type: CANVAS_FRAME_MESSAGE_TYPES.ready });
    await waitFor(() =>
      expect(
        postMessage.mock.calls.filter(([m]) => (m as { html?: string }).html === '<p>v2</p>')
      ).toHaveLength(2)
    );
  });
});
