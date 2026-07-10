import 'katex/dist/katex.min.css';
import {
  isValidElement,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { cn } from '../lib/utils';
import { extractFrontmatter } from './frontmatter';
import { FrontmatterBlock } from './frontmatter-block';
import { MarkdownCodeBlock } from './markdown-code-block';
import { MarkdownImage } from './markdown-image';
import { MermaidBlock } from './mermaid-block';

export interface MarkdownSurfaceProps {
  /** Accessible label for the scrollable region. */
  readonly ariaLabel?: string;
  readonly initialScrollTop?: number;
  /** Non-anchor link clicks (http, mailto, relative paths) — the host decides. */
  readonly onOpenLink: (href: string) => void;
  readonly onScrollTopChange?: (scrollTop: number) => void;
  /** Resolve a raw image src (relative or absolute path) to a displayable URL. Reject => visible placeholder. */
  readonly resolveImageSrc: (src: string) => Promise<string>;
  readonly testId?: string;
  /** Set when the host truncated the document (mirrors CodeSurface's contract). */
  readonly truncated?: boolean;
  readonly value: string;
}

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeSlug, rehypeKatex];

interface FencedCode {
  readonly code: string;
  readonly language: string;
}

/** Read the single <code class="language-x"> child that react-markdown puts
 * inside <pre> for a fenced block. Returns null for anything unexpected so the
 * default <pre> rendering still applies. */
function extractFencedCode(children: ReactNode): FencedCode | null {
  if (!isValidElement(children)) {
    return null;
  }
  const props = children.props as { children?: ReactNode; className?: string };
  const match = /language-([\w-]+)/.exec(props.className ?? '');
  if (!(match?.[1] && typeof props.children === 'string')) {
    return null;
  }
  return { code: props.children.replace(/\n$/, ''), language: match[1] };
}

export function MarkdownSurface({
  ariaLabel,
  initialScrollTop,
  onOpenLink,
  onScrollTopChange,
  resolveImageSrc,
  testId,
  truncated,
  value,
}: MarkdownSurfaceProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const frontmatter = useMemo(() => extractFrontmatter(value), [value]);

  // Mount-only restore, mirroring CodeSurface's contract: an imperative one-time
  // scroll restore, not derived state. The ref freezes the mount-time value so
  // the empty dep array cannot read a stale later prop.
  const initialScrollTopRef = useRef(initialScrollTop);
  // biome-ignore lint/plugin: one-time imperative scroll restore on mount, not a data-fetch/derived-state effect
  useLayoutEffect(() => {
    const initial = initialScrollTopRef.current;
    if (containerRef.current && typeof initial === 'number' && initial > 0) {
      containerRef.current.scrollTop = initial;
    }
  }, []);

  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      onScrollTopChange?.(containerRef.current.scrollTop);
    }
  }, [onScrollTopChange]);

  const handleLinkClick = useCallback(
    (href: string) => {
      if (href.startsWith('#')) {
        // Anchor navigation is a best-effort affordance. A malformed anchor (e.g. "#%")
        // makes decodeURIComponent throw, and click-handler throws aren't caught by React
        // error boundaries. Scrolling is a pure convenience (no data loss on failure), so
        // swallow the decode/scroll error and simply don't scroll rather than crash.
        try {
          const id = decodeURIComponent(href.slice(1));
          containerRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          });
        } catch {
          // Malformed anchor — no-op (scrolling is an optional affordance).
        }
        return;
      }
      onOpenLink(href);
    },
    [onOpenLink]
  );

  const components = useMemo<Components>(
    () => ({
      a: ({ children, href }) => (
        <a
          href={href ?? '#'}
          onClick={(event) => {
            event.preventDefault();
            if (href) {
              handleLinkClick(href);
            }
          }}
        >
          {children}
        </a>
      ),
      img: ({ alt, src }) =>
        typeof src === 'string' ? (
          <MarkdownImage alt={alt ?? ''} key={src} resolveImageSrc={resolveImageSrc} src={src} />
        ) : null,
      pre: ({ children }) => {
        const fenced = extractFencedCode(children);
        if (!fenced) {
          return <pre>{children}</pre>;
        }
        if (fenced.language === 'mermaid') {
          return <MermaidBlock code={fenced.code} key={fenced.code} />;
        }
        return <MarkdownCodeBlock code={fenced.code} language={fenced.language} />;
      },
    }),
    [handleLinkClick, resolveImageSrc]
  );

  return (
    <section
      aria-label={ariaLabel}
      className="h-full overflow-auto"
      data-testid={testId}
      onScroll={handleScroll}
      ref={containerRef}
    >
      <div className={cn('prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-4')}>
        {truncated ? (
          <p className="rounded-md border border-amber-500/40 bg-muted/50 p-2 text-amber-600 text-xs dark:text-amber-400">
            Document truncated for display. Switch to Source to confirm the cutoff.
          </p>
        ) : null}
        <FrontmatterBlock result={frontmatter} />
        <ReactMarkdown
          components={components}
          rehypePlugins={REHYPE_PLUGINS}
          remarkPlugins={REMARK_PLUGINS}
        >
          {frontmatter.body}
        </ReactMarkdown>
      </div>
    </section>
  );
}
