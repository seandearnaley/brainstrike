import { memo } from 'react';
import '@assistant-ui/react-markdown/styles/dot.css';
import { useMessagePartText } from '@assistant-ui/react';
import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
} from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlockHeader } from '../code-block/code-block-header';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import { SyntaxHighlighterComponent } from './shiki-highlighter';

const REMARK_PLUGINS = [remarkGfm];

// Test-visible seam: markdown-text-clipboard.test.tsx (and any external
// consumer) imports the hook from this module.
export { useCopyToClipboard } from '../hooks/use-copy-to-clipboard';

export const MarkdownText = memo(function MarkdownTextImpl() {
  const { status, text, type } = useMessagePartText();

  if (type === 'text' && status.type === 'running' && text.trim().length === 0) {
    return <AssistantThinkingIndicator className="bs-streaming-thinking" markClassName="size-4" />;
  }

  return (
    <MarkdownTextPrimitive
      className="aui-md"
      components={defaultComponents}
      // Parse at deferred priority (useDeferredValue): without this the full
      // remark/GFM parse re-runs synchronously over ALL accumulated text on
      // every streamed chunk — quadratic over a long response and a main
      // source of streaming jank. Under load intermediate parses coalesce;
      // the final text always renders.
      defer
      remarkPlugins={REMARK_PLUGINS}
    />
  );
});

// Module-scope adapter (NOT inline in defaultComponents): an inline component
// would get a new identity per render and remount every streamed chunk.
function CodeHeader({ language, code }: CodeHeaderProps) {
  return <CodeBlockHeader code={code ?? ''} language={language} />;
}

const defaultComponents = memoizeMarkdownComponents({
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "CodeHeader" key
  CodeHeader,
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "SyntaxHighlighter" key
  SyntaxHighlighter: SyntaxHighlighterComponent,
});
