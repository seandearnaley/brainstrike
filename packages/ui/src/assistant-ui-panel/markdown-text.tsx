import { memo, useState } from 'react';
import '@assistant-ui/react-markdown/styles/dot.css';
import { useMessagePartText } from '@assistant-ui/react';
import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
} from '@assistant-ui/react-markdown';
import { createClipboardService } from '@brainstrike/context-actions';
import { createLogger } from '@brainstrike/utils/logger';
import { CheckIcon, CopyIcon } from 'lucide-react';
import remarkGfm from 'remark-gfm';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import { SyntaxHighlighterComponent } from './shiki-highlighter';
import { TooltipIconButton } from './tooltip-icon-button';

const REMARK_PLUGINS = [remarkGfm];
const logger = createLogger('MarkdownText');
const clipboard = createClipboardService();

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

function CodeHeader({ language, code }: CodeHeaderProps) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  const onCopy = () => {
    if (isCopied || !code) {
      return;
    }
    copyToClipboard(String(code));
  };

  return (
    <div className="aui-code-header-root flex items-center justify-between rounded-t-lg bg-muted px-4 py-2 font-semibold text-sm">
      <span className="aui-code-header-language text-xs lowercase opacity-70">
        {language || 'code'}
      </span>
      <TooltipIconButton
        aria-label="Copy code to clipboard"
        className="size-6"
        onClick={onCopy}
        size="icon"
        tooltip={isCopied ? 'Copied!' : 'Copy code'}
        variant="ghost"
      >
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </TooltipIconButton>
    </div>
  );
}

export function useCopyToClipboard({ copiedDuration = 2000 } = {}) {
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = (value: string) => {
    if (!value) {
      return;
    }
    const text = String(value);
    const markCopied = () => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    };
    // Route through the shared clipboard service so a present-but-broken
    // Electron bridge is surfaced (never silently falls back to navigator).
    void clipboard.writeText(text).then((outcome) => {
      if (outcome.ok) {
        markCopied();
        return;
      }
      logger.warn('Failed to copy code to clipboard', { error: outcome.error });
    });
  };
  return { copyToClipboard, isCopied } as const;
}

const defaultComponents = memoizeMarkdownComponents({
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "CodeHeader" key
  CodeHeader,
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "SyntaxHighlighter" key
  SyntaxHighlighter: SyntaxHighlighterComponent,
});
