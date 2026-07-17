import { createContext, type ReactNode, use } from 'react';

export interface MarkdownPreviewCapabilities {
  /** Open http(s)/mailto externally. Resolves {ok:false,error} on failure — callers toast. */
  readonly openExternalLink: (url: string) => Promise<{ ok: boolean; error?: string }>;
  /** Resolve a workspace path (absolute on desktop, root-relative on web) to a displayable URL. Rejects with a reason. */
  readonly resolveImageSrc: (path: string) => Promise<string>;
}

const MarkdownPreviewCapabilitiesContext = createContext<MarkdownPreviewCapabilities | null>(null);

export function MarkdownPreviewCapabilitiesProvider({
  capabilities,
  children,
}: {
  readonly capabilities: MarkdownPreviewCapabilities;
  readonly children: ReactNode;
}) {
  return (
    <MarkdownPreviewCapabilitiesContext.Provider value={capabilities}>
      {children}
    </MarkdownPreviewCapabilitiesContext.Provider>
  );
}

/** Nullable by design: an absent provider means the surface shows explicit
 * "unavailable" states (placeholder/toast), never a silent degradation. */
export function useMarkdownPreviewCapabilities(): MarkdownPreviewCapabilities | null {
  return use(MarkdownPreviewCapabilitiesContext);
}
