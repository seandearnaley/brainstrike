import { useMessagePartText } from '@assistant-ui/react';
import {
  type CodeHeaderProps,
  type StreamdownTextComponents,
  StreamdownTextPrimitive,
  type SyntaxHighlighterProps,
} from '@assistant-ui/react-streamdown';
import { stripProviderCitationMarkers } from '@brainstrike/assistant-contract/citation-markers';
import { CodeBlockHeader } from '@brainstrike/ui/code-block';
import { type ComponentPropsWithoutRef, type ComponentType, memo } from 'react';
import { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
// The keyframes behind `animated` (sd-fadeIn and the list-marker fade).
import 'streamdown/styles.css';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import { MarkdownLink } from './markdown-link';
import { SyntaxHighlighterComponent } from './shiki-highlighter';

const REMARK_PLUGINS = [remarkGfm];

// Module scope: a stable identity for the reveal options.
const REVEAL = { animation: 'fadeIn', sep: 'word' } as const;

// No rehype-raw / sanitize / harden: Streamdown's default pipeline renders raw
// HTML from the model (sanitized). Model output keeps the react-markdown
// behaviour instead: without rehype-raw, Streamdown turns HTML into literal
// text, and `defaultUrlTransform` drops unsafe link and image protocols.
const REHYPE_PLUGINS: [] = [];

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
    // Streamdown splits the reply into blocks and memoizes each finished one,
    // so a streamed token re-parses only the open block instead of the whole
    // reply (BST-1929).
    <StreamdownTextPrimitive
      caret="circle"
      className="aui-md"
      components={defaultComponents}
      controls={false}
      // Spread rather than `preprocess={preprocess}`: under
      // exactOptionalPropertyTypes an explicit `undefined` is not assignable to
      // the library's optional prop.
      {...(preprocess ? { preprocess } : {})}
      // The reveal: Streamdown fades each arriving word in with CSS keyframes,
      // so a token costs one React commit (BST-1929). The frame-paced
      // `smooth` reveal committed on every animation frame instead.
      animated={REVEAL}
      rehypePlugins={REHYPE_PLUGINS}
      remarkPlugins={REMARK_PLUGINS}
      // The table owns its height, as before: no capped scroll box.
      tableMaxHeight={0}
      urlTransform={defaultUrlTransform}
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

// Module scope: Streamdown's per-block memo compares each component by
// identity, so a stable map keeps finished blocks from re-rendering.
//
// Workaround for a vendor type defect: `StreamdownTextComponents`
// (@assistant-ui/react-streamdown dist/types.d.ts, unchanged through 0.3.20)
// intersects streamdown's `[key: string]: ComponentType<Record<string, unknown>>`
// index signature with the CodeHeader/SyntaxHighlighter keys, so no component
// with required props satisfies both. `satisfies` still checks every entry
// against its documented prop type. Remove the cast once the vendor type stops
// intersecting the index signature.
const defaultComponents = {
  // The anchor default is unusable on both platforms (see markdown-link.tsx):
  // the desktop renderer's navigation fence denies it, and on web it would
  // navigate the whole app away. Link activation is routed to the host instead.
  a: MarkdownLink,
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "CodeHeader" key
  CodeHeader,
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "SyntaxHighlighter" key
  SyntaxHighlighter: SyntaxHighlighterComponent,
} satisfies {
  readonly a: ComponentType<ComponentPropsWithoutRef<'a'>>;
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "CodeHeader" key
  readonly CodeHeader: ComponentType<CodeHeaderProps>;
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "SyntaxHighlighter" key
  readonly SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
} as unknown as StreamdownTextComponents;
