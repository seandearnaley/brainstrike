import type { SyntaxHighlighterProps } from '@assistant-ui/react-streamdown';
import { lazy, memo, Suspense } from 'react';
import { useIsCodeFenceIncomplete } from 'streamdown';
import { SyntaxHighlighterComponent } from './shiki-highlighter';

// Pele and the KaTeX its labels use load with the first diagram, not with the chat.
const MermaidBlock = lazy(() =>
  import('@brainstrike/ui/mermaid-block').then((m) => ({ default: m.MermaidBlock }))
);

/**
 * Chat-pipeline body for a ```mermaid fence: Pele draws it, as in the Markdown
 * viewer, under the shared code header (which still copies the source). A
 * fence that is still streaming shows as code, so a half-written diagram never
 * flashes a parse error; it draws once the fence closes or the reply ends.
 */
const MermaidHighlighterImpl = (props: SyntaxHighlighterProps) => {
  const incomplete = useIsCodeFenceIncomplete();
  if (incomplete) {
    return <SyntaxHighlighterComponent {...props} />;
  }
  return (
    <Suspense fallback={<SyntaxHighlighterComponent {...props} />}>
      <div className="border-border rounded-b-md border border-t-0 p-3">
        <MermaidBlock code={props.code} key={props.code} />
      </div>
    </Suspense>
  );
};

export const MermaidHighlighterComponent = memo(MermaidHighlighterImpl);
