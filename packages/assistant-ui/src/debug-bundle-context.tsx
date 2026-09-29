import { createContext, type ReactNode, use } from 'react';

/**
 * Capability-injection seam for the Flight Recorder "Copy debug bundle"
 * button, structurally PARALLEL to RunVerdictContext: the binding closes
 * over the app-shell's db handle + selected thread id, so the ui-side
 * button only ever passes the run it detected on its own message part.
 */
export interface DebugBundleBinding {
  /** Builds (collects + formats) the Markdown debug bundle for the bound
   * thread, optionally scoped to one run. Rejects on collection/formatting
   * failure — the button surfaces a visible `Copy failed: …`, never a
   * silent drop. */
  buildBundle(input: { runId: string | null }): Promise<string>;
  /** Full retained thread/subtree export, independent of run outcome. */
  buildThreadPack?(): Promise<string>;
}

const DebugBundleContext = createContext<DebugBundleBinding | null>(null);

export function DebugBundleProvider({
  value,
  children,
}: {
  value: DebugBundleBinding | null;
  children: ReactNode;
}) {
  return <DebugBundleContext.Provider value={value}>{children}</DebugBundleContext.Provider>;
}

/**
 * The debug-bundle binding, or `null` when no provider supplied one —
 * capability gating, never a disabled stub.
 */
export function useDebugBundleContext(): DebugBundleBinding | null {
  return use(DebugBundleContext);
}
