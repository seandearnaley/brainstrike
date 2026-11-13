import { Bot } from 'lucide-react';
import type React from 'react';
import { cn } from '../../lib/utils';

interface GlyphProps {
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
}

/**
 * Single-colour brand marks, drawn in `currentColor` so they follow the
 * theme, contrast tokens and forced colours. Path data: simple-icons 15.22.0
 * (CC0); the marks stay their owners' trademarks and keep their shapes.
 */
const BRAND_PATHS = {
  anthropic:
    'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
  google:
    'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z',
  openai:
    'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  openrouter:
    'M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z',
} as const;

type BrandMarkId = keyof typeof BRAND_PATHS;

function isBrandMark(id: string | undefined): id is BrandMarkId {
  return id !== undefined && Object.hasOwn(BRAND_PATHS, id);
}

function BrandGlyph({ className, id, style }: GlyphProps & { id: BrandMarkId }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      height="24"
      style={style}
      viewBox="0 0 24 24"
      width="24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={BRAND_PATHS[id]} />
    </svg>
  );
}

/**
 * Amazon Bedrock (BST-1350): a neutral layered-stack glyph, not the AWS logo.
 * Pair it with the AWS-orange PROVIDER_COLOR_MAP entry where colour is used.
 */
function BedrockGlyph({ className, style }: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      style={style}
      viewBox="0 0 24 24"
      width="24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 2 3 7l9 5 9-5-9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  );
}

/** The maker whose mark a route wears: ChatGPT is OpenAI's own route. */
function routeBrand(id: string): BrandMarkId | undefined {
  if (id === 'chatgpt') {
    return 'openai';
  }
  return isBrandMark(id) ? id : undefined;
}

/** A route's own mark: a brand mark, the Bedrock glyph, or a generic bot for anything else. */
function RouteGlyph({ className, id, style }: GlyphProps & { id: string }) {
  const brand = routeBrand(id);
  if (brand) {
    return <BrandGlyph className={className} id={brand} style={style} />;
  }
  if (id === 'bedrock') {
    return <BedrockGlyph className={className} style={style} />;
  }
  return <Bot aria-hidden="true" className={className} style={style} />;
}

/** A provider (route) mark, as Settings shows beside a provider's name. */
export function ProviderIcon({
  className,
  providerId,
  style,
}: {
  className?: string;
  providerId: string;
  style?: React.CSSProperties;
}) {
  return <RouteGlyph className={className} id={providerId} style={style} />;
}

export interface ModelMarkProps {
  readonly className?: string | undefined;
  /**
   * The mark's accessible name, such as "Anthropic via OpenRouter". Omit it
   * where text beside the mark already names the model's maker and route.
   */
  readonly label?: string | undefined;
  /** The route that serves the model: `openai`, `openrouter`, `bedrock`… */
  readonly provider: string;
  /** The model's maker as its catalog row declares it; absent for an uncatalogued model. */
  readonly vendor?: string | undefined;
}

/**
 * A model's maker mark. When a gateway serves a maker that has its own mark
 * (Claude through OpenRouter or Bedrock), the route's mark follows it as a
 * small badge, so both facts show. A maker with no mark shows its route's.
 */
export function ModelMark({ className, label, provider, vendor }: ModelMarkProps) {
  const maker = isBrandMark(vendor) ? vendor : undefined;
  const badge = maker !== undefined && maker !== routeBrand(provider);
  const attributes = {
    className: cn('inline-flex shrink-0 items-end gap-px', className),
    'data-model-mark': maker ?? provider,
    'data-model-route': badge ? provider : undefined,
  };
  const glyphs = (
    <>
      {maker ? (
        <BrandGlyph className="size-3.5" id={maker} />
      ) : (
        <RouteGlyph className="size-3.5" id={provider} />
      )}
      {badge ? <RouteGlyph className="text-muted-foreground size-2" id={provider} /> : null}
    </>
  );
  return label ? (
    <span {...attributes} aria-label={label} role="img" title={label}>
      {glyphs}
    </span>
  ) : (
    <span {...attributes} aria-hidden="true">
      {glyphs}
    </span>
  );
}
