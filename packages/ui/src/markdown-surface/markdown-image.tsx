import { useEffect, useState } from 'react';

export interface MarkdownImageProps {
  readonly alt: string;
  readonly resolveImageSrc: (src: string) => Promise<string>;
  readonly src: string;
}

type ImageState =
  | { readonly kind: 'loading' }
  // Resolved but not yet decoded: the img loads hidden behind the placeholder.
  | { readonly kind: 'resolved'; readonly url: string }
  | { readonly kind: 'ready'; readonly url: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The box an image holds until it has decoded. The resolver yields only a URL,
 * never the image's size, so this is a fixed landscape box rather than the
 * image's own shape: the page shifts once, when the image appears, instead of
 * growing from a line of text through an empty img to its full height.
 */
const PLACEHOLDER_CLASS_NAME =
  'bg-muted text-muted-foreground flex aspect-video w-full max-w-md items-center justify-center rounded px-2 text-center text-xs';

/** Async image: resolves the raw markdown src through the injected capability.
 * Failure renders an explicit placeholder naming the path — never a broken img. */
export function MarkdownImage({ alt, resolveImageSrc, src }: MarkdownImageProps) {
  const [state, setState] = useState<ImageState>({ kind: 'loading' });

  // Async resolution of the raw markdown src through the injected capability;
  // the URL is not derivable during render. This component is remounted per
  // `src` (keyed in markdown-surface), so the initial `loading` state covers
  // every new src — no in-effect reset needed. The active-flag + blob-revocation
  // cleanup still guards an unmount mid-flight.
  // biome-ignore lint/plugin: async src resolution (data fetch), not derived state
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    resolveImageSrc(src)
      .then((url) => {
        if (!active) {
          if (url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
          }
          return;
        }
        objectUrl = url.startsWith('blob:') ? url : null;
        setState({ kind: 'resolved', url });
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
        className="border-muted-foreground/40 text-muted-foreground inline-block rounded border border-dashed px-2 py-1 text-xs"
        data-testid="markdown-image-error"
        role="img"
      >
        Image unavailable: {src} ({state.message})
      </span>
    );
  }
  const placeholder = <span className={PLACEHOLDER_CLASS_NAME}>Loading image… {alt || src}</span>;
  if (state.kind === 'loading') {
    return placeholder;
  }
  const { url } = state;
  // A resolved src can still fail to load: desktop's resolveImageSrc only mints a
  // brainstrike-asset:// URL (never rejects), so a protocol 404 or a CSP-blocked remote
  // image would otherwise render a silent broken-image glyph. onError promotes the load
  // failure to the same visible placeholder as a resolve failure.
  return (
    <>
      {state.kind === 'resolved' ? placeholder : null}
      {/* biome-ignore lint/correctness/useImageSize: host-resolved image has unknown intrinsic dimensions; the placeholder holds its place until it decodes and max-w-full constrains it after */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: onLoad/onError are media-load events on img, not user interactions */}
      <img
        alt={alt}
        className={state.kind === 'ready' ? 'max-w-full' : 'hidden'}
        onError={() => setState({ kind: 'error', message: 'Image failed to load' })}
        onLoad={() => setState({ kind: 'ready', url })}
        src={url}
      />
    </>
  );
}
