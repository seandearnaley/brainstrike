/**
 * Branded HTML pages served by the loopback OAuth callback server (BST-1355).
 *
 * Structure cribbed from opencode's `packages/core/src/oauth/page.ts`
 * (self-contained card, light/dark via prefers-color-scheme, auto-close on
 * success), restyled for Brainstrike. Fully self-contained by contract: no
 * external assets, so the page renders offline and leaks nothing.
 */

export interface CallbackPageOptions {
  /** Friendly provider name shown in the message, e.g. "OpenAI Codex". */
  readonly providerLabel: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLES = `
  :root {
    color-scheme: light dark;
    --bs-bg: #f7f7f8;
    --bs-card: #ffffff;
    --bs-text-strong: #18181b;
    --bs-text-base: #52525b;
    --bs-text-weak: #8b8b93;
    --bs-border: #e4e4e7;
    --bs-success: #16a34a;
    --bs-error: #dc2626;
    --bs-shadow: 0 16px 48px -6px rgba(0,0,0,.10), 0 6px 12px -2px rgba(0,0,0,.05);
    --bs-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bs-bg: #101012;
      --bs-card: #17171a;
      --bs-text-strong: rgba(255,255,255,.93);
      --bs-text-base: rgba(255,255,255,.62);
      --bs-text-weak: rgba(255,255,255,.42);
      --bs-border: #29292e;
      --bs-success: #22c55e;
      --bs-error: #f87171;
      --bs-shadow: 0 16px 48px -6px rgba(0,0,0,.55), 0 6px 12px -2px rgba(0,0,0,.35);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--bs-bg);
    color: var(--bs-text-base);
    font-family: var(--bs-font);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(100%, 26rem);
    padding: 2.25rem 2rem 1.75rem;
    background: var(--bs-card);
    border: 1px solid var(--bs-border);
    border-radius: 14px;
    box-shadow: var(--bs-shadow);
    text-align: center;
  }
  .brand {
    font-size: 0.9375rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--bs-text-strong);
    margin-bottom: 1.5rem;
  }
  .brand .bolt { color: var(--bs-success); }
  .icon { margin-bottom: 1rem; }
  .icon svg { display: inline-block; }
  .icon-success { color: var(--bs-success); }
  .icon-error { color: var(--bs-error); }
  h1 { margin: 0; font-size: 1.1875rem; font-weight: 500; color: var(--bs-text-strong); }
  .message { margin: 0.5rem 0 0; font-size: 0.9375rem; }
  .footnote { margin: 1.5rem 0 0; font-size: 0.8125rem; color: var(--bs-text-weak); }
`;

const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.4 2.4 4.6-5.4" /></svg>';

const ICON_CROSS =
  '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg>';

const AUTO_CLOSE_SCRIPT = 'setTimeout(function(){try{window.close()}catch(e){}},2500)';

function renderDocument(input: {
  readonly title: string;
  readonly iconClass: string;
  readonly iconSvg: string;
  readonly headline: string;
  readonly message: string;
  readonly footnote: string;
  readonly autoClose: boolean;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(input.title)} - Brainstrike</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main class="card" role="status" aria-live="polite">
      <div class="brand">Brain<span class="bolt">strike</span></div>
      <div class="icon ${input.iconClass}" aria-hidden="true">${input.iconSvg}</div>
      <h1>${escapeHtml(input.headline)}</h1>
      <p class="message">${escapeHtml(input.message)}</p>
      <p class="footnote">${escapeHtml(input.footnote)}</p>
    </main>${input.autoClose ? `\n    <script>${AUTO_CLOSE_SCRIPT}</script>` : ''}
  </body>
</html>`;
}

export function renderCallbackSuccessPage(options: CallbackPageOptions): string {
  return renderDocument({
    autoClose: true,
    footnote: 'You can close this window.',
    headline: 'Authorization successful',
    iconClass: 'icon-success',
    iconSvg: ICON_CHECK,
    message: `Brainstrike is now connected to ${options.providerLabel}.`,
    title: 'Authorization successful',
  });
}

/**
 * Error page. `detail` is a SHORT human-readable reason (e.g. "State mismatch
 * - potential CSRF"); callers must never pass token material or authorization
 * codes through it.
 */
export function renderCallbackErrorPage(options: CallbackPageOptions, detail: string): string {
  return renderDocument({
    autoClose: false,
    footnote: 'Close this window and try again from Brainstrike.',
    headline: 'Authorization failed',
    iconClass: 'icon-error',
    iconSvg: ICON_CROSS,
    message: `Brainstrike could not finish connecting to ${options.providerLabel}. ${detail}`,
    title: 'Authorization failed',
  });
}
