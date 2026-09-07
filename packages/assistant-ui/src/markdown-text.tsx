import { memo } from 'react';
import '@assistant-ui/react-markdown/styles/dot.css';
import { useMessagePartText } from '@assistant-ui/react';
import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
} from '@assistant-ui/react-markdown';
import { stripProviderCitationMarkers } from '@brainstrike/assistant-contract/citation-markers';
import { CodeBlockHeader } from '@brainstrike/ui/code-block';
import remarkGfm from 'remark-gfm';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import { MarkdownLink } from './markdown-link';
import { SyntaxHighlighterComponent } from './shiki-highlighter';

const REMARK_PLUGINS = [remarkGfm];

// Test-visible seam: markdown-text-clipboard.test.tsx (and any external
// consumer) imports the hook from this module.
export { useCopyToClipboard } from '@brainstrike/ui';

function MarkdownTextImpl({ preprocess }: { preprocess?: ((text: string) => string) | undefined }) {
  const { status, text, type } = useMessagePartText();
  // Must match what the primitive will actually render: a chunk that is nothing
  // BUT a half-arrived marker has non-empty raw text but preprocesses to '', so
  // testing the raw text here would drop the streaming dots and leave the
  // message blank until real prose arrives.
  const visibleText = preprocess ? preprocess(text) : text;

  if (type === 'text' && status.type === 'running' && visibleText.trim().length === 0) {
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
      // Spread rather than `preprocess={preprocess}`: under
      // exactOptionalPropertyTypes an explicit `undefined` is not assignable to
      // the library's optional prop.
      {...(preprocess ? { preprocess } : {})}
      remarkPlugins={REMARK_PLUGINS}
    />
  );
}

/**
 * Assistant-authored markdown. Strips provider citation markers via the
 * library's `preprocess` hook, which receives the FULL accumulated text (not a
 * single delta), so a marker split across streamed chunks is matched whole.
 *
 * This is the seam every assistant text part passes through — live stream and
 * reload hydration alike — so the strip lives here once rather than per
 * provider. It is NOT literally all rendered model text: reasoning parts render
 * raw via AssistantReasoningPart, which applies the same strip directly.
 */
export const MarkdownText = memo(function MarkdownText() {
  return <MarkdownTextImpl preprocess={stripProviderCitationMarkers} />;
});

/**
 * User-authored markdown. Renders verbatim: the citation strip must never touch
 * content the user typed or pasted. Someone pasting the raw marker sequence to
 * ask about it — or using these private-use codepoints intentionally, they are
 * also Nerd Fonts icon glyphs — must see their own message unaltered.
 */
export const UserMarkdownText = memo(function UserMarkdownText() {
  return <MarkdownTextImpl />;
});

// Module-scope adapter (NOT inline in defaultComponents): an inline component
// would get a new identity per render and remount every streamed chunk.
function CodeHeader({ language, code }: CodeHeaderProps) {
  return <CodeBlockHeader code={code ?? ''} language={language} />;
}

const defaultComponents = memoizeMarkdownComponents({
  // The anchor default is unusable on both platforms (see markdown-link.tsx):
  // the desktop renderer's navigation fence denies it, and on web it would
  // navigate the whole app away. Link activation is routed to the host instead.
  a: MarkdownLink,
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "CodeHeader" key
  CodeHeader,
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "SyntaxHighlighter" key
  SyntaxHighlighter: SyntaxHighlighterComponent,
});
