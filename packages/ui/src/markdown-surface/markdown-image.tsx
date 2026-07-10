import { useEffect, useState } from 'react';

export interface MarkdownImageProps {
  readonly alt: string;
  readonly resolveImageSrc: (src: string) => Promise<string>;
  readonly src: string;
}

type ImageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly url: string }
  | { readonly kind: 'error'; readonly message: string };

/** Async image: resolves the raw markdown src through the injected capability.
 * Failure renders an explicit placeholder naming the path — never a broken img. */
export function MarkdownImage({ alt, resolveImageSrc, src }: MarkdownImageProps) {
  const [state, setState] = useState<ImageState>({ kind: 'loading' });

  // Async resolution of the raw markdown src through the injected capability;
  // the URL is not derivable during render.
  // biome-ignore lint/plugin: async src resolution (data fetch), not derived state
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setState({ kind: 'loading' });
    resolveImageSrc(src)
      .then((url) => {
        if (!active) {
          if (url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
          }
          return;
        }
        objectUrl = url.startsWith('blob:') ? url : null;
        setState({ kind: 'ready', url });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [resolveImageSrc, src]);

  if (state.kind === 'error') {
    return (
      <span
        aria-label={`Image unavailable: ${src}`}
        className="inline-block rounded border border-muted-foreground/40 border-dashed px-2 py-1 text-muted-foreground text-xs"
        data-testid="markdown-image-error"
        role="img"
      >
        Image unavailable: {src} ({state.message})
      </span>
    );
  }
  if (state.kind === 'loading') {
    return (
      <span className="inline-block rounded bg-muted px-2 py-1 text-muted-foreground text-xs">
        Loading image… {alt || src}
      </span>
    );
  }
  // A resolved src can still fail to load: desktop's resolveImageSrc only mints a
  // brainstrike-asset:// URL (never rejects), so a protocol 404 or a CSP-blocked remote
  // image would otherwise render a silent broken-image glyph. onError promotes the load
  // failure to the same visible placeholder as a resolve failure.
  return (
    // biome-ignore lint/correctness/useImageSize: host-resolved image has unknown intrinsic dimensions; max-w-full constrains layout
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError is a media-load event on img, not a user interaction
    <img
      alt={alt}
      className="max-w-full"
      onError={() => setState({ kind: 'error', message: 'Image failed to load' })}
      src={state.url}
    />
  );
}
