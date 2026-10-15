import path from 'node:path';
import type { DesktopRendererLaunchMode } from './desktop-launch-mode';

/** Built renderers load one document on this origin, served by `renderer-protocol.ts`. */
export const APP_RENDERER_SCHEME = 'brainstrike-app';
export const APP_RENDERER_DOCUMENT_URL = `${APP_RENDERER_SCHEME}://bundle/index.html`;

/** The hidden hosts that run local inference on ONNX Runtime's WASM threads. */
const CROSS_ORIGIN_ISOLATED_HOST_MODES: ReadonlySet<string> = new Set([
  'embedding-host',
  'llm-host',
]);
const EMBEDDER_POLICY = { 'Cross-Origin-Embedder-Policy': 'require-corp' } as const;

/**
 * The cross-origin isolation headers for one renderer response (BST-1999).
 * A hidden inference host's document opts in (COOP and COEP), so its workers
 * get SharedArrayBuffer and ONNX Runtime picks its own WASM thread count.
 * Every other same-origin response carries COEP, which a worker script needs
 * to start under an isolated document and which an ordinary document ignores.
 * The visible document stays unisolated: it frames the Canvas and MCP App
 * shells, which COEP would block.
 */
export function rendererIsolationHeaders(
  url: URL,
  documentPathnames: readonly string[]
): Readonly<Record<string, string>> {
  if (!documentPathnames.includes(url.pathname)) {
    return EMBEDDER_POLICY;
  }
  return CROSS_ORIGIN_ISOLATED_HOST_MODES.has(url.searchParams.get('mode') ?? '')
    ? { ...EMBEDDER_POLICY, 'Cross-Origin-Opener-Policy': 'same-origin' }
    : {};
}

/** The document a loader loads for this target; hidden hosts add their query. */
export function rendererDocumentUrl(target: DesktopRendererTarget): string {
  return target.kind === 'built-renderer' ? APP_RENDERER_DOCUMENT_URL : target.url;
}

/**
 * The ONE resolved description of the renderer document this process loads
 * (BST-1641). `main.ts` resolves the launch mode once, builds this target,
 * and configures it process-wide before any BrowserWindow exists. Every
 * consumer that must agree on that document — the visible window loader
 * (`create-window.ts`), the hidden host loader (`renderer-host-lifecycle.ts`),
 * and the IPC sender-frame allowlist (`platform/desktop-ipc-sender-frame.ts`)
 * — resolves this same object instead of re-deriving the launch mode from
 * `process.argv` / `app.isPackaged` / test-mode flags in its own way. That is
 * what makes "the allowlist trusts a document the loaders never load" (or the
 * reverse) impossible by construction: there is no second derivation to drift.
 *
 * Resolution before configuration throws, so a loader that runs ahead of
 * `main.ts` fails at load time with a named error rather than surfacing as
 * every authorized IPC channel rejecting at first invoke.
 */
export type DesktopRendererTarget =
  | {
      readonly kind: 'built-renderer';
      readonly launchMode: 'built' | 'test-built';
      /** Absolute on-disk path of `dist/renderer/index.html` (normalized). */
      readonly rendererPath: string;
    }
  | {
      readonly kind: 'dev-renderer';
      readonly launchMode: 'dev-server';
      /** The configured Vite dev-server URL, loaded verbatim by `loadURL`. */
      readonly url: string;
    };

interface CreateDesktopRendererTargetInput {
  readonly builtRendererPath: string;
  readonly devRendererUrl: string;
  readonly launchMode: DesktopRendererLaunchMode;
}

export function createDesktopRendererTarget(
  input: CreateDesktopRendererTargetInput
): DesktopRendererTarget {
  switch (input.launchMode) {
    case 'built':
    case 'test-built':
      return {
        kind: 'built-renderer',
        launchMode: input.launchMode,
        rendererPath: path.normalize(input.builtRendererPath),
      };
    case 'dev-server':
      // Parse eagerly so a malformed dev URL fails here, at boot, not inside
      // the allowlist on the first IPC call.
      new URL(input.devRendererUrl);
      return { kind: 'dev-renderer', launchMode: 'dev-server', url: input.devRendererUrl };
    default: {
      const unsupported: never = input.launchMode;
      throw new Error(`Unsupported desktop launch mode "${String(unsupported)}".`);
    }
  }
}

let configuredTarget: DesktopRendererTarget | null = null;

/**
 * Installs the process-wide renderer target. `main.ts` calls this exactly
 * once per boot; passing `null` clears it (tests only).
 */
export function configureDesktopRendererTarget(target: DesktopRendererTarget | null): void {
  configuredTarget = target;
}

export function resolveDesktopRendererTarget(): DesktopRendererTarget {
  if (!configuredTarget) {
    throw new Error('Desktop renderer target is not configured.');
  }
  return configuredTarget;
}
