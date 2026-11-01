import {
  CANVAS_FRAME_MESSAGE_TYPES,
  type CanvasConsoleLevel,
  type CanvasRenderCommand,
  type CanvasTheme,
  isCanvasFrameInboundMessage,
} from '@brainstrike/platform-utils';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

export interface CanvasConsoleEvent {
  readonly level: CanvasConsoleLevel;
  readonly text: string;
}

export interface CanvasErrorEvent {
  readonly text: string;
}

export interface CanvasShellTimeoutEvent {
  readonly shellSrc: string;
  readonly timeoutMs: number;
}

const DEFAULT_SHELL_READY_TIMEOUT_MS = 8000;

export interface CanvasFrameProps {
  readonly className?: string;
  /** Untrusted assistant-generated document body. Never rendered outside the sandbox. */
  readonly html: string;
  readonly onConsoleEvent?: (event: CanvasConsoleEvent) => void;
  readonly onErrorEvent?: (event: CanvasErrorEvent) => void;
  /**
   * Called whenever the shell announces readiness — including a LATE ready
   * after `onShellTimeout` already fired. Consumers surfacing the timeout must
   * clear that state here (the frame recovers by contract).
   */
  readonly onShellReady?: () => void;
  /**
   * Called when the shell fails to announce readiness within
   * `shellReadyTimeoutMs` (shell request failed, protocol unavailable, CSP
   * refused execution). Fires at most once per silent period; a late ready
   * still recovers the frame.
   */
  readonly onShellTimeout?: (event: CanvasShellTimeoutEvent) => void;
  readonly shellReadyTimeoutMs?: number;
  /**
   * URL of the trusted Canvas shell document (`brainstrike-canvas://shell/`
   * in the desktop app). The shell MUST be served with the
   * canvas sandbox CSP as a response header (see
   * `@brainstrike/platform-utils` canvas-sandbox module for the full model).
   */
  readonly shellSrc: string;
  readonly theme: CanvasTheme;
}

/**
 * Sandboxed host for assistant-rendered canvas content (BST-1173).
 *
 * Renders the trusted shell in an iframe locked to `sandbox="allow-scripts"`
 * (no `allow-same-origin` — the shell and everything inside it runs in an
 * opaque origin with no storage and no host DOM access). Content and theme are
 * delivered to the shell over `postMessage` after the shell announces
 * readiness with the per-mount fragment nonce; console/error output from the
 * canvas is relayed back through validated messages.
 */
export function CanvasFrame({
  className,
  html,
  onConsoleEvent,
  onErrorEvent,
  onShellReady,
  onShellTimeout,
  shellReadyTimeoutMs = DEFAULT_SHELL_READY_TIMEOUT_MS,
  shellSrc,
  theme,
}: CanvasFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [nonce] = useState(() => crypto.randomUUID());
  // Incremented on every ready announcement so a shell reload (e.g. renderer
  // recovery) replays the current content instead of losing it.
  const [readyGeneration, setReadyGeneration] = useState(0);

  const callbacksRef = useRef({ onConsoleEvent, onErrorEvent, onShellReady, onShellTimeout });
  useEffect(() => {
    callbacksRef.current = { onConsoleEvent, onErrorEvent, onShellReady, onShellTimeout };
  }, [onConsoleEvent, onErrorEvent, onShellReady, onShellTimeout]);

  // NO SILENT FALLBACKS: if the shell never announces ready (request failed,
  // protocol unregistered, CSP refused execution), a blank frame must not hang
  // forever — report the bounded handshake failure to the consumer.
  useEffect(() => {
    if (readyGeneration > 0) {
      return;
    }
    const timer = setTimeout(() => {
      callbacksRef.current.onShellTimeout?.({ shellSrc, timeoutMs: shellReadyTimeoutMs });
    }, shellReadyTimeoutMs);
    return () => {
      clearTimeout(timer);
    };
  }, [readyGeneration, shellReadyTimeoutMs, shellSrc]);

  // useLayoutEffect (not useEffect): the iframe starts loading at commit and
  // the desktop shell is served from an in-memory protocol response, so its
  // READY can fire before a passive (post-paint) effect attaches this
  // listener. Layout effects run synchronously before the browser resumes;
  // the shell additionally re-announces READY until a render command arrives.
  useLayoutEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const shellWindow = iframeRef.current?.contentWindow;
      if (!shellWindow || event.source !== shellWindow) {
        return;
      }
      if (!isCanvasFrameInboundMessage(event.data, nonce)) {
        return;
      }
      const message = event.data;
      switch (message.type) {
        case CANVAS_FRAME_MESSAGE_TYPES.ready:
          setReadyGeneration((generation) => generation + 1);
          callbacksRef.current.onShellReady?.();
          return;
        case CANVAS_FRAME_MESSAGE_TYPES.relayConsole:
          callbacksRef.current.onConsoleEvent?.({ level: message.level, text: message.text });
          return;
        case CANVAS_FRAME_MESSAGE_TYPES.relayError:
          callbacksRef.current.onErrorEvent?.({ text: message.text });
          return;
        default:
          return;
      }
    };
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [nonce]);

  useEffect(() => {
    if (readyGeneration === 0) {
      return;
    }
    const command: CanvasRenderCommand = {
      html,
      theme,
      type: CANVAS_FRAME_MESSAGE_TYPES.render,
    };
    // The shell runs in an opaque origin, so '*' is the only addressable
    // target; authenticity is enforced by the source check + nonce protocol,
    // and the command carries no secrets.
    iframeRef.current?.contentWindow?.postMessage(command, '*');
  }, [html, readyGeneration, theme]);

  return (
    <iframe
      className={cn('h-full w-full border-0 bg-transparent', className)}
      ref={iframeRef}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      src={`${shellSrc}#nonce=${nonce}`}
      title="Canvas"
    />
  );
}
