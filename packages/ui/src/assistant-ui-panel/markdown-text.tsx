import { memo, useState } from 'react';
import '@assistant-ui/react-markdown/styles/dot.css';
import { useMessagePartText } from '@assistant-ui/react';
import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
} from '@assistant-ui/react-markdown';
import { CheckIcon, CopyIcon } from 'lucide-react';
import remarkGfm from 'remark-gfm';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import { SyntaxHighlighterComponent } from './shiki-highlighter';
import { TooltipIconButton } from './tooltip-icon-button';

export const MarkdownText = memo(function MarkdownTextImpl() {
  const { status, text, type } = useMessagePartText();

  if (type === 'text' && status.type === 'running' && text.trim().length === 0) {
    return <AssistantThinkingIndicator className="bs-streaming-thinking" markClassName="size-4" />;
  }

  return (
    <MarkdownTextPrimitive
      className="aui-md"
      components={defaultComponents}
      remarkPlugins={[remarkGfm]}
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

function useCopyToClipboard({ copiedDuration = 2000 } = {}) {
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = (value: string) => {
    if (!value) {
      return;
    }
    const text = String(value);
    // Prefer Electron clipboard if available
    const electronClipboard = (
      window as unknown as { clipboard?: { writeText?: (t: string) => boolean } }
    ).clipboard;
    if (typeof window !== 'undefined' && typeof electronClipboard?.writeText === 'function') {
      const ok = electronClipboard.writeText?.(text) as boolean;
      if (ok) {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), copiedDuration);
        return;
      }
    }
    // Fallback to web clipboard API
    navigator.clipboard.writeText(text).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };
  return { isCopied, copyToClipboard } as const;
}

const defaultComponents = memoizeMarkdownComponents({
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "SyntaxHighlighter" key
  SyntaxHighlighter: SyntaxHighlighterComponent,
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "CodeHeader" key
  CodeHeader,
});
