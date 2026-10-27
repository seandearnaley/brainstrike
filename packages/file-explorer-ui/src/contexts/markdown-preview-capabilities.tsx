import { createContext, type ReactNode, use } from 'react';

/** A link outcome; the host has already shown any failure. */
interface LinkChoiceResult {
  readonly error?: string;
  readonly ok: boolean;
}

/**
 * Where a web link can go besides the default browser, when the host has a
 * browser of its own. Each call shows its own outcome and never rejects.
 */
export interface MarkdownLinkChoices {
  readonly copyLink: (url: string) => Promise<LinkChoiceResult>;
  /** Whether `url` can open in the host's browser. */
  readonly offers: (url: string) => boolean;
  readonly openInAppBrowser: (url: string) => Promise<LinkChoiceResult>;
}

export interface MarkdownPreviewCapabilities {
  /** Present when the host has its own browser: a web link then asks where to open. */
  readonly linkChoices?: MarkdownLinkChoices | undefined;
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
