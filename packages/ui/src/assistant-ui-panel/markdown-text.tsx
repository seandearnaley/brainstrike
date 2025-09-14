import type { ReactNode } from 'react';
import { memo, useState } from 'react';
import '@assistant-ui/react-markdown/styles/dot.css';
import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';

export const MarkdownText = memo(function MarkdownTextImpl() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md"
      components={defaultComponents}
    />
  );
});

function CodeHeader({ language, code }: CodeHeaderProps) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };
  return (
    <div className="aui-code-header-root">
      <span className="aui-code-header-language">{language}</span>
      <button
        type="button"
        className="aui-button aui-button-ghost aui-button-icon"
        onClick={onCopy}
      >
        <span className="aui-sr-only">Copy</span>
        {isCopied ? '✓' : '⧉'}
      </button>
    </div>
  );
}

function useCopyToClipboard({ copiedDuration = 2000 } = {}) {
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = (value: string) => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };
  return { isCopied, copyToClipboard } as const;
}

const defaultComponents = memoizeMarkdownComponents({
  code: function Code(props: unknown) {
    const isBlock = useIsMarkdownCodeBlock();
    const { children, className } = (props ?? {}) as { children?: ReactNode; className?: string };
    const cls = !isBlock ? ['aui-md-inline-code', className].filter(Boolean).join(' ') : className;
    return <code className={cls}>{children}</code>;
  },
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "CodeHeader" key
  CodeHeader,
});
