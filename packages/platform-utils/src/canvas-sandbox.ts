/**
 * Canvas sandbox contract (BST-1173).
 *
 * The Canvas surface renders UNTRUSTED assistant-generated HTML/JS. Isolation
 * is a two-layer design:
 *
 * 1. The host app embeds a trusted static "shell" document in an iframe
 *    sandboxed with `allow-scripts` ONLY (no `allow-same-origin` → opaque
 *    origin, no storage, no host DOM). The shell must be served with the
 *    policy from {@link getCanvasSandboxContentSecurityPolicy} as a real
 *    response header — Electron via the `brainstrike-canvas:` protocol, web
 *    via per-path headers on `/canvas-frame.html`. Serving it under the APP
 *    policy instead would break canvas inline scripts in production only
 *    (the app's prod `script-src` has no `unsafe-inline`), because…
 * 2. …the shell hosts the actual canvas content in a nested `srcdoc` iframe,
 *    and CSP local-scheme inheritance gives that document the SHELL's policy:
 *    inline execution allowed, zero network, zero navigation targets.
 *
 * Message flow (all `postMessage`, all validated):
 *   host → shell: render command (only accepted from `window.parent`)
 *   shell → host: ready / console-relay / error-relay, each carrying the
 *     per-mount nonce the host put in the shell URL FRAGMENT. Canvas content
 *     cannot read the shell's URL (cross-origin), so it cannot forge
 *     shell-level messages; its own direct messages fail the host's
 *     `event.source` check.
 */

export const CANVAS_FRAME_MESSAGE_TYPES = {
  ready: 'brainstrike-canvas:ready',
  relayConsole: 'brainstrike-canvas:relay:console',
  relayError: 'brainstrike-canvas:relay:error',
  render: 'brainstrike-canvas:render',
} as const;

export const CANVAS_CONSOLE_LEVELS = ['debug', 'error', 'info', 'log', 'warn'] as const;
export type CanvasConsoleLevel = (typeof CANVAS_CONSOLE_LEVELS)[number];

export type CanvasTheme = 'dark' | 'light';

export interface CanvasRenderCommand {
  readonly html: string;
  readonly theme: CanvasTheme;
  readonly type: typeof CANVAS_FRAME_MESSAGE_TYPES.render;
}

export interface CanvasReadyMessage {
  readonly nonce: string;
  readonly type: typeof CANVAS_FRAME_MESSAGE_TYPES.ready;
}

export interface CanvasConsoleRelayMessage {
  readonly level: CanvasConsoleLevel;
  readonly nonce: string;
  readonly text: string;
  readonly type: typeof CANVAS_FRAME_MESSAGE_TYPES.relayConsole;
}

export interface CanvasErrorRelayMessage {
  readonly nonce: string;
  readonly text: string;
  readonly type: typeof CANVAS_FRAME_MESSAGE_TYPES.relayError;
}

export type CanvasFrameInboundMessage =
  | CanvasConsoleRelayMessage
  | CanvasErrorRelayMessage
  | CanvasReadyMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The shell clamps relayed text to {@link CANVAS_RELAY_MAX_TEXT} before
 * forwarding, so anything longer at the host is by definition forged or a
 * shell bug — reject it rather than clamp again.
 */
function isBoundedRelayText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CANVAS_RELAY_MAX_TEXT;
}

/**
 * Validate a message received by the HOST from the shell iframe. The caller
 * must additionally verify `event.source` is the shell iframe's
 * `contentWindow`; this guard covers shape + nonce.
 */
export function isCanvasFrameInboundMessage(
  data: unknown,
  expectedNonce: string
): data is CanvasFrameInboundMessage {
  if (!isRecord(data) || data['nonce'] !== expectedNonce) {
    return false;
  }
  switch (data['type']) {
    case CANVAS_FRAME_MESSAGE_TYPES.ready:
      return true;
    case CANVAS_FRAME_MESSAGE_TYPES.relayConsole:
      return (
        isBoundedRelayText(data['text']) &&
        CANVAS_CONSOLE_LEVELS.includes(data['level'] as CanvasConsoleLevel)
      );
    case CANVAS_FRAME_MESSAGE_TYPES.relayError:
      return isBoundedRelayText(data['text']);
    default:
      return false;
  }
}

/**
 * The policy every canvas document runs under. Served as a real header on the
 * shell response AND embedded as a parse-time meta tag (defense in depth; the
 * nested srcdoc inherits whichever policies bind the shell, and CSP
 * combination only ever narrows).
 *
 * Deliberate omissions: `connect-src` (default-src 'none' kills fetch/XHR/WS),
 * `frame-ancestors` (header-only directive; the shell MUST stay embeddable and
 * meta CSP ignores it anyway), `worker-src`/`frame-src` (canvas content gets
 * neither workers nor nested frames).
 */
export function getCanvasSandboxContentSecurityPolicy(): string {
  return [
    "base-uri 'none'",
    "default-src 'none'",
    'font-src data:',
    "form-action 'none'",
    'img-src data: blob:',
    "object-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
  ].join('; ');
}

/** Path the web app serves the shell under (dev middleware + vercel.json). */
export const CANVAS_FRAME_SHELL_PATH = '/canvas-frame.html';

/**
 * Hard cap on relayed console/error text, enforced IN THE TRUSTED SHELL (the
 * prelude's copy of the clamp runs in the untrusted realm and is bypassable by
 * posting to the shell directly). The host validator rejects anything longer
 * as malformed.
 */
export const CANVAS_RELAY_MAX_TEXT = 8000;

/**
 * Total relay messages the shell forwards per rendered document. The last
 * budget slot is spent on an explicit truncation notice so exhaustion is
 * visible, never silent.
 */
export const CANVAS_RELAY_BUDGET = 500;

/**
 * Console/error relay prelude injected into the srcdoc BEFORE canvas content.
 * Runs in the same realm as canvas code, so canvas code can trivially "forge"
 * console events — that is fine: console data is untrusted display data. What
 * it cannot forge is shell-level messages (ready), because those require the
 * nonce, which lives in the shell's URL, unreadable across the opaque-origin
 * boundary.
 *
 * `</script>` never appears literally: the closing tag would terminate the
 * SHELL's own bootstrap script at parse time.
 */
const SCRIPT_CLOSE = '</script>';

/**
 * Embed a string as a JS string literal INSIDE an inline `<script>` block.
 * `JSON.stringify` alone is not enough: it leaves `</` unescaped, and a
 * literal `</script>` inside the payload would terminate the surrounding
 * script element at HTML-parse time. `<\/` is an identical JS escape that the
 * HTML parser does not recognize as a close tag.
 */
function embedAsJsString(value: string): string {
  return JSON.stringify(value).replace(/<\//gu, String.raw`<\/`);
}

const PRELUDE_SOURCE = `(() => {
  'use strict';
  const MAX_TEXT = ${CANVAS_RELAY_MAX_TEXT};
  const serialize = (value) => {
    if (typeof value === 'string') { return value; }
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
  };
  const relay = (type, payload) => {
    try { window.parent.postMessage(Object.assign({ type: type }, payload), '*'); } catch {}
  };
  const levels = ['debug', 'error', 'info', 'log', 'warn'];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      relay('brainstrike-canvas:relay:console', {
        level: level,
        text: args.map(serialize).join(' ').slice(0, MAX_TEXT),
      });
      original(...args);
    };
  }
  window.addEventListener('error', (event) => {
    relay('brainstrike-canvas:relay:error', { text: String(event.message).slice(0, MAX_TEXT) });
  });
  window.addEventListener('unhandledrejection', (event) => {
    relay('brainstrike-canvas:relay:error', { text: serialize(event.reason).slice(0, MAX_TEXT) });
  });
})();`;

/**
 * Render the static Canvas shell document. Fully self-contained: no external
 * references of any scheme, deterministic output, no per-render state (the
 * per-mount nonce arrives via the URL fragment, set by the host).
 */
export function renderCanvasFrameShellHtml(): string {
  const csp = getCanvasSandboxContentSecurityPolicy();
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Canvas</title>
<style>
html, body { margin: 0; padding: 0; height: 100%; background: transparent; }
iframe { display: block; border: 0; width: 100%; height: 100%; background: transparent; }
</style>
</head>
<body>
<script>
(() => {
  'use strict';
  const RENDER = 'brainstrike-canvas:render';
  const READY = 'brainstrike-canvas:ready';
  const RELAY_CONSOLE = 'brainstrike-canvas:relay:console';
  const RELAY_ERROR = 'brainstrike-canvas:relay:error';
  const LEVELS = ['debug', 'error', 'info', 'log', 'warn'];
  const MAX_TEXT = ${CANVAS_RELAY_MAX_TEXT};
  const MAX_RELAYS = ${CANVAS_RELAY_BUDGET};
  const CSP = ${JSON.stringify(csp)};
  const PRELUDE = ${embedAsJsString(`<script>${PRELUDE_SOURCE}${SCRIPT_CLOSE}`)};
  const nonce = new URLSearchParams(location.hash.slice(1)).get('nonce') ?? '';
  let inner = null;
  let relayBudget = 0;
  let hasReceivedRender = false;
  const post = (message) => {
    window.parent.postMessage(Object.assign({}, message, { nonce: nonce }), '*');
  };
  const render = (html, theme) => {
    hasReceivedRender = true;
    relayBudget = MAX_RELAYS;
    if (inner) {
      inner.remove();
      inner = null;
    }
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', 'Canvas content');
    const colorScheme = theme === 'dark' ? 'dark' : 'light';
    frame.srcdoc =
      '<meta http-equiv="Content-Security-Policy" content="' + CSP + '" />' +
      '<meta name="color-scheme" content="' + colorScheme + '" />' +
      PRELUDE +
      html;
    document.body.append(frame);
    inner = frame;
  };
  // Relay messages come FROM THE UNTRUSTED REALM. This trusted shell is the
  // enforcement point: rebuild every message from validated parts (never
  // forward attacker-shaped objects), clamp text here — the prelude's own
  // clamp is bypassable — and budget total relays per rendered document so a
  // flood cannot reach host React state.
  const relay = (data) => {
    if (relayBudget <= 0) {
      return;
    }
    let message = null;
    if (data.type === RELAY_CONSOLE && LEVELS.indexOf(data.level) !== -1 && typeof data.text === 'string') {
      message = { level: data.level, text: data.text.slice(0, MAX_TEXT), type: RELAY_CONSOLE };
    } else if (data.type === RELAY_ERROR && typeof data.text === 'string') {
      message = { text: data.text.slice(0, MAX_TEXT), type: RELAY_ERROR };
    }
    if (!message) {
      return;
    }
    relayBudget -= 1;
    if (relayBudget === 0) {
      post({ text: 'canvas output truncated: relay budget exhausted', type: RELAY_ERROR });
      return;
    }
    post(message);
  };
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') {
      return;
    }
    if (event.source === window.parent) {
      if (data.type === RENDER && typeof data.html === 'string') {
        render(data.html, data.theme);
      }
      return;
    }
    if (inner && event.source === inner.contentWindow) {
      relay(data);
    }
  });
  // Re-announce readiness until the host's first render command arrives: the
  // host attaches its listener in a React effect, and this document (served
  // from an in-memory protocol response) can parse before that listener
  // exists. A lost one-shot READY would otherwise leave the pane blank.
  post({ type: READY });
  let announceAttempts = 0;
  const announceTimer = setInterval(() => {
    announceAttempts += 1;
    if (hasReceivedRender || announceAttempts >= 40) {
      clearInterval(announceTimer);
      return;
    }
    post({ type: READY });
  }, 250);
})();
</script>
</body>
</html>
`;
}
