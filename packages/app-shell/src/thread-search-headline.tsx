import type { ReactNode } from 'react';

const MARK_PATTERN = /<mark>(.*?)<\/mark>/gs;

/**
 * Renders a ts_headline snippet: `<mark>` tokens become real highlight
 * elements, everything else stays plain TEXT — persisted message content is
 * never interpreted as HTML. Lives in its own module (not the component file)
 * so it is a pure non-component export.
 */
export function renderMarkedText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(MARK_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }
    nodes.push(
      <mark className="rounded-[2px] bg-primary/20 px-px text-inherit" key={`mark-${key}`}>
        {match[1]}
      </mark>
    );
    key += 1;
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}
