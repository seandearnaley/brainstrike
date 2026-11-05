/// <reference path="../vite-env.d.ts" />
import 'katex/dist/katex.min.css';
import { isValidElement, type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { smoothScrollBehavior } from '../lib/motion';
import { cn } from '../lib/utils';
import { LinkChoiceMenu, type LinkChoices } from '../link-choice-menu';
import { extractFrontmatter } from './frontmatter';
import { FrontmatterBlock } from './frontmatter-block';
import { MarkdownCodeBlock } from './markdown-code-block';
import { MarkdownImage } from './markdown-image';
import { MermaidBlock } from './mermaid-block';

export interface MarkdownSurfaceProps {
  /** Accessible label for the scrollable region. */
  readonly ariaLabel?: string;
  readonly initialScrollTop?: number;
  /**
   * Optional: where a link the host can also open in its own browser may go.
   * A link it returns choices for asks first; any other link, or a null
   * answer, goes straight to `onOpenLink`.
   */
  readonly linkChoices?: ((href: string) => LinkChoices | null) | undefined;
  /** Synchronous, surface-bounded DOM selection snapshot taken on `contextmenu`. */
  readonly onContextMenuSelection?:
    | ((selection: MarkdownSurfaceContextMenuSelection) => void)
    | undefined;
  /** Non-anchor link clicks (http, mailto, relative paths) — the host decides. */
  readonly onOpenLink: (href: string) => void;
  /**
   * The scroll position once scrolling settles (`scrollend`), not on every scroll frame,
   * and once more on unmount if a scroll had not settled yet.
   */
  readonly onScrollTopChange?: (scrollTop: number) => void;
  /** Resolve a raw image src (relative or absolute path) to a displayable URL. Reject => visible placeholder. */
  readonly resolveImageSrc: (src: string) => Promise<string>;
  readonly testId?: string;
  /** Set when the host truncated the document (mirrors CodeSurface's contract). */
  readonly truncated?: boolean;
  readonly value: string;
}

export interface MarkdownSurfaceContextMenuSelection {
  /** Exact selected text; null for collapsed, empty, or cross-surface selections. */
  readonly text: string | null;
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
  const match = /language-([\w-]+)/u.exec(props.className ?? '');
  if (!(match?.[1] && typeof props.children === 'string')) {
    return null;
  }
  return { code: props.children.replace(/\n$/u, ''), language: match[1] };
}

export function MarkdownSurface({
  ariaLabel,
  initialScrollTop,
  linkChoices,
  onContextMenuSelection,
  onOpenLink,
  onScrollTopChange,
  resolveImageSrc,
  testId,
  truncated,
  value,
}: MarkdownSurfaceProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const frontmatter = extractFrontmatter(value);

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

  const onScrollTopChangeRef = useRef(onScrollTopChange);
  useEffect(() => {
    onScrollTopChangeRef.current = onScrollTopChange;
  }, [onScrollTopChange]);

  // React has no `scrollend` prop, so subscribe to the DOM events directly. The
  // position of a scroll not yet reported is recorded on `scroll`, because the cleanup
  // runs after React detaches the section, when `scrollTop` reads 0.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let unreportedScrollTop: number | null = null;
    const handleScroll = () => {
      unreportedScrollTop = container.scrollTop;
    };
    const handleScrollEnd = () => {
      unreportedScrollTop = null;
      onScrollTopChangeRef.current?.(container.scrollTop);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('scrollend', handleScrollEnd, { passive: true });
    return () => {
      // Unmounting mid-scroll (a tab switch, preview/source toggle) still saves where
      // the user was; without a scroll there is nothing to report.
      if (unreportedScrollTop !== null) {
        onScrollTopChangeRef.current?.(unreportedScrollTop);
      }
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('scrollend', handleScrollEnd);
    };
  }, []);

  const handleContextMenu = () => {
    if (!onContextMenuSelection) {
      return;
    }
    const container = containerRef.current;
    const selection = typeof window === 'undefined' ? null : window.getSelection();
    if (
      !(container && selection) ||
      selection.rangeCount === 0 ||
      selection.isCollapsed ||
      !selection.anchorNode ||
      !selection.focusNode ||
      !container.contains(selection.anchorNode) ||
      !container.contains(selection.focusNode)
    ) {
      onContextMenuSelection({ text: null });
      return;
    }
    const text = selection.toString();
    onContextMenuSelection({ text: text.length > 0 ? text : null });
  };

  const handleLinkClick = (href: string) => {
    if (href.startsWith('#')) {
      // Anchor navigation is a best-effort affordance. A malformed anchor (e.g. "#%")
      // makes decodeURIComponent throw, and click-handler throws aren't caught by React
      // error boundaries. Scrolling is a pure convenience (no data loss on failure), so
      // swallow the decode/scroll error and simply don't scroll rather than crash.
      try {
        const id = decodeURIComponent(href.slice(1));
        containerRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({
          behavior: smoothScrollBehavior(),
          block: 'start',
        });
      } catch {
        // Malformed anchor — no-op (scrolling is an optional affordance).
      }
      return;
    }
    onOpenLink(href);
  };

  const components: Components = {
    a: ({ children, href }) => {
      const choices = href ? (linkChoices?.(href) ?? null) : null;
      const anchor = (
        <a
          href={href ?? '#'}
          onClick={(event) => {
            event.preventDefault();
            if (href && !choices) {
              handleLinkClick(href);
            }
          }}
        >
          {children}
        </a>
      );
      return choices ? <LinkChoiceMenu choices={choices}>{anchor}</LinkChoiceMenu> : anchor;
    },
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
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: read-only document surface exposes a standard context menu without changing its region semantics
    <section
      aria-label={ariaLabel}
      className="h-full overflow-auto"
      data-testid={testId}
      onContextMenu={handleContextMenu}
      ref={containerRef}
    >
      <div className={cn('prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-4')}>
        {truncated ? (
          <p className="bg-muted/50 text-warning rounded-md border border-amber-500/40 p-2 text-xs">
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
