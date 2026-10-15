import {
  type DesktopRendererTarget,
  rendererDocumentUrl,
  resolveDesktopRendererTarget,
} from '../desktop-renderer-target';

/**
 * Second sender factor for `registerAuthorizedInvoke` (BST-1641).
 *
 * `event.sender.id` → window role proves WHICH tracked webContents sent a
 * message; `event.senderFrame.url` proves WHAT document that webContents is
 * currently running. Electron's security checklist ("Validate the sender of
 * all IPC messages") validates the frame URL against an allowlist; this
 * module owns that allowlist. It is a pure derivation of the process-wide
 * `DesktopRendererTarget` — the same object `create-window.ts` and
 * `renderer-host-lifecycle.ts` load their document from — so the allowlist
 * can never trust a document the loaders do not load, or reject the one they
 * do. It is launch-mode-exact: a built renderer (packaged, `pnpm start`, or
 * the Playwright `--test-mode` harness) accepts ONLY the bundled app-origin
 * document, and the dev-server mode accepts ONLY the configured Vite origin
 * document — so a built app never trusts `http://localhost:38181` or a `file://` page, and
 * dev accepts only its configured document. Hidden inference hosts load
 * the SAME document with `?mode=<role>&runtimeId=…`, so query and fragment
 * are ignored.
 *
 * Only the pathname's trailing slash is normalized (`/desktop` ≡ `/desktop/`,
 * which Vite serves interchangeably); the comparison stays equality, so
 * `/desktop/index.html`, `/desktop-evil`, and path-prefix spoofs still fail.
 * The renderer is a single-document app (no history routing — see
 * `docs/agents/platform-contracts.md`), so the pathname is stable for the
 * life of the frame.
 *
 * Tests construct an allowlist directly from a target; production resolves
 * it from the target `main.ts` configured. Resolution without a configured
 * target throws — the registry never falls back to accepting an unverified
 * frame.
 */
export type DesktopIpcSenderFrameAllowlist =
  | {
      readonly kind: 'built-renderer';
      /** Exact bundled application document URL. */
      readonly documentUrl: string;
    }
  | {
      readonly kind: 'dev-renderer';
      readonly origin: string;
      /** Trailing-slash-normalized pathname (`/` stays `/`). */
      readonly pathname: string;
    };

function normalizePathname(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

export function createDesktopIpcSenderFrameAllowlist(
  target: DesktopRendererTarget
): DesktopIpcSenderFrameAllowlist {
  switch (target.kind) {
    case 'built-renderer':
      return { documentUrl: rendererDocumentUrl(target), kind: 'built-renderer' };
    case 'dev-renderer': {
      const devUrl = new URL(target.url);
      return {
        kind: 'dev-renderer',
        origin: devUrl.origin,
        pathname: normalizePathname(devUrl.pathname),
      };
    }
    default: {
      const unsupported: never = target;
      throw new Error(`Unsupported desktop renderer target ${JSON.stringify(unsupported)}.`);
    }
  }
}

function parseSenderFrameUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function matchesBuiltRenderer(documentUrl: string, url: URL): boolean {
  const expected = new URL(documentUrl);
  return (
    url.protocol === expected.protocol &&
    url.host === expected.host &&
    url.pathname === expected.pathname &&
    url.username === '' &&
    url.password === ''
  );
}

export function isAllowedDesktopIpcSenderFrameUrl(
  allowlist: DesktopIpcSenderFrameAllowlist,
  senderFrameUrl: string
): boolean {
  const url = parseSenderFrameUrl(senderFrameUrl);
  if (!url) {
    return false;
  }
  if (allowlist.kind === 'built-renderer') {
    return matchesBuiltRenderer(allowlist.documentUrl, url);
  }
  return url.origin === allowlist.origin && normalizePathname(url.pathname) === allowlist.pathname;
}

let derivedAllowlist: {
  readonly allowlist: DesktopIpcSenderFrameAllowlist;
  readonly target: DesktopRendererTarget;
} | null = null;

/**
 * The allowlist every registry consults when no explicit allowlist was
 * injected: derived from the process-wide renderer target `main.ts`
 * configured (cached per target identity). Throws while no target is
 * configured, so an authorized invoke can never be evaluated against an
 * unconfigured allowlist.
 */
export function resolveDesktopIpcSenderFrameAllowlist(): DesktopIpcSenderFrameAllowlist {
  const target = resolveDesktopRendererTarget();
  if (derivedAllowlist?.target !== target) {
    derivedAllowlist = { allowlist: createDesktopIpcSenderFrameAllowlist(target), target };
  }
  return derivedAllowlist.allowlist;
}
