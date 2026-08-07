import { cn } from '@brainstrike/ui';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

/**
 * Collapses long message content behind a "Show more"/"Show less" toggle once it
 * overflows `collapsedHeight`. Measures via ResizeObserver so the toggle only
 * appears when there is genuinely hidden content.
 */
export const ExpandableMessageContent = ({
  children,
  className,
  collapsedHeight = 176,
  testId,
}: {
  children: ReactNode;
  className: string;
  collapsedHeight?: number;
  testId?: string;
}) => {
  const innerContentRef = useRef<HTMLDivElement | null>(null);
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    const node = innerContentRef.current;
    if (!node) {
      return;
    }

    const measure = (): void => {
      const nextContentHeight = node.scrollHeight;
      setHasOverflow(nextContentHeight > collapsedHeight + 1);
    };

    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [collapsedHeight, children]);

  const collapsed = hasOverflow && !expanded;

  return (
    <div className={cn(className, 'bs-expandable-message')} data-testid={testId}>
      <div
        className="bs-expandable-message-body"
        id={contentId}
        style={{ maxHeight: expanded ? undefined : collapsedHeight }}
      >
        <div className="bs-expandable-message-content" ref={innerContentRef}>
          {children}
        </div>
      </div>
      {collapsed ? <div aria-hidden="true" className="bs-expandable-message-fade" /> : null}
      {hasOverflow ? (
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={expanded ? 'Show less message content' : 'Show more message content'}
          className="bs-expandable-message-toggle"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
};
