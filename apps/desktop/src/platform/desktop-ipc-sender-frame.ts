import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesktopRendererLaunchMode } from '../desktop-launch-mode';

/**
 * Second sender factor for `registerAuthorizedInvoke` (BST-1641).
 *
 * `event.sender.id` → window role proves WHICH tracked webContents sent a
 * message; `event.senderFrame.url` proves WHAT document that webContents is
 * currently running. Electron's security checklist ("Validate the sender of
 * all IPC messages") validates the frame URL against an allowlist; this
 * module owns that allowlist. It is launch-mode-exact: a built renderer
 * (packaged, `pnpm start`, or the Playwright `--test-mode` harness) accepts
 * ONLY the dist `file://` document, and the dev-server mode accepts ONLY the
 * configured Vite origin document — so a packaged app never trusts
 * `http://localhost:38181` and a dev app never trusts a stray `file://` page.
 * Hidden inference hosts load the SAME document with `?mode=<role>&runtimeId=…`
 * (see `renderer-host-lifecycle.ts`), so query and fragment are ignored.
 *
 * The allowlist carries no Electron dependency so tests construct it
 * directly; production configures the process-wide instance once from
 * `main.ts` (after the launch mode is resolved, before any window exists).
 * Resolution without configuration throws — the registry never falls back
 * to accepting an unverified frame.
 */
export type DesktopIpcSenderFrameAllowlist =
  | {
      readonly kind: 'built-renderer';
      /** Absolute on-disk path of `dist/renderer/index.html` (normalized). */
      readonly rendererPath: string;
    }
  | {
      readonly kind: 'dev-renderer';
      readonly origin: string;
      readonly pathname: string;
    };

interface CreateDesktopIpcSenderFrameAllowlistInput {
  readonly builtRendererPath: string;
  readonly devRendererUrl: string;
  readonly launchMode: DesktopRendererLaunchMode;
}

export function createDesktopIpcSenderFrameAllowlist(
  input: CreateDesktopIpcSenderFrameAllowlistInput
): DesktopIpcSenderFrameAllowlist {
  switch (input.launchMode) {
    case 'built':
    case 'test-built':
      return { kind: 'built-renderer', rendererPath: path.normalize(input.builtRendererPath) };
    case 'dev-server': {
      const devUrl = new URL(input.devRendererUrl);
      return { kind: 'dev-renderer', origin: devUrl.origin, pathname: devUrl.pathname };
    }
    default: {
      const unsupported: never = input.launchMode;
      throw new Error(`Unsupported desktop launch mode "${String(unsupported)}".`);
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

function matchesBuiltRenderer(rendererPath: string, url: URL): boolean {
  if (url.protocol !== 'file:') {
    return false;
  }
  try {
    // `fileURLToPath` decodes percent-escapes and ignores query/fragment, so
    // the hidden hosts' `?mode=…&runtimeId=…` variants compare equal to the
    // visible document while `index.html.evil` or a sibling file do not.
    return path.normalize(fileURLToPath(url)) === rendererPath;
  } catch {
    return false;
  }
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
    return matchesBuiltRenderer(allowlist.rendererPath, url);
  }
  return url.origin === allowlist.origin && url.pathname === allowlist.pathname;
}

let configuredAllowlist: DesktopIpcSenderFrameAllowlist | null = null;

/**
 * Installs the process-wide allowlist every registry consults when no
 * explicit allowlist was injected. `main.ts` calls this exactly once per
 * boot; passing `null` clears it (tests only).
 */
export function configureDesktopIpcSenderFrameAllowlist(
  allowlist: DesktopIpcSenderFrameAllowlist | null
): void {
  configuredAllowlist = allowlist;
}

export function resolveDesktopIpcSenderFrameAllowlist(): DesktopIpcSenderFrameAllowlist {
  if (!configuredAllowlist) {
    throw new Error('Desktop IPC sender-frame allowlist is not configured.');
  }
  return configuredAllowlist;
}
