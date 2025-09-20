import type { ReactNode } from 'react';
import { memo, useRef, useState } from 'react';
import '@assistant-ui/react-markdown/styles/dot.css';
import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';

// Registry to associate rendered block code elements with their plain text
const codeTextRegistry = new Map<string, string>();
let lastCodeId: string | null = null;
let codeIdCounter = 0;
function nextCodeId(): string {
  codeIdCounter += 1;
  return `code-${codeIdCounter}`;
}

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
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  function findCodeInPre(el: Element | null): string | null {
    const pre = el?.closest('pre');
    const preCode = pre?.querySelector('code');
    const text = preCode?.textContent ?? null;
    return text && text.length > 0 ? text : null;
  }

  function findCodeNearHeader(el: Element | null): string | null {
    const header = el?.closest('.aui-code-header-root');
    const nextCode = header?.nextElementSibling?.querySelector('code');
    if (nextCode?.textContent && nextCode.textContent.length > 0) {
      return nextCode.textContent;
    }
    const prevCode = header?.previousElementSibling?.querySelector('code');
    if (prevCode?.textContent && prevCode.textContent.length > 0) {
      return prevCode.textContent;
    }
    return null;
  }

  function searchAncestorForCode(el: Element | null, maxLevels: number): string | null {
    let node: Element | null = el;
    for (let i = 0; i < maxLevels && node; i += 1) {
      const found = node.querySelector?.('code');
      if (found?.textContent && found.textContent.length > 0) return found.textContent;
      node = node.parentElement;
    }
    return null;
  }

  function findInMessageContainer(el: Element | null): string | null {
    let node: Element | null = el;
    const isMsgContainer = (n: Element) =>
      n.classList?.contains('aui-assistant-message-content') ||
      n.classList?.contains('aui-user-message-content') ||
      n.classList?.contains('aui-assistant-message-root') ||
      n.classList?.contains('aui-user-message-root');
    while (node?.parentElement) {
      if (isMsgContainer(node)) {
        const codeEl = node.querySelector('pre code') ?? node.querySelector('code');
        const text = codeEl?.textContent ?? null;
        return text && text.length > 0 ? text : null;
      }
      node = node.parentElement;
    }
    return null;
  }

  function getFromNeighbor(header: Element | null): string | null {
    const byAttr = header?.nextElementSibling
      ?.querySelector('code[data-code-text]')
      ?.getAttribute('data-code-text');
    if (byAttr && byAttr.length > 0) return byAttr;
    const byIdEl = header?.nextElementSibling?.querySelector(
      'code[data-code-id]'
    ) as HTMLElement | null;
    const byId = byIdEl?.getAttribute?.('data-code-id') ?? null;
    if (byId && codeTextRegistry.has(byId)) return codeTextRegistry.get(byId) ?? null;
    return null;
  }

  function getFromMessageContainer(btn: Element): string | null {
    const msg = btn.closest(
      '.aui-assistant-message-content, .aui-user-message-content'
    ) as HTMLElement | null;
    if (!msg) return null;
    const attrEl = msg.querySelector('code[data-code-text]') as HTMLElement | null;
    const txt = attrEl?.getAttribute?.('data-code-text') ?? null;
    if (txt && txt.length > 0) return txt;
    const idEl = msg.querySelector('code[data-code-id]') as HTMLElement | null;
    const id = idEl?.getAttribute?.('data-code-id') ?? null;
    if (id && codeTextRegistry.has(id)) return codeTextRegistry.get(id) ?? null;
    return null;
  }

  function getFromHeuristics(btn: Element): string | null {
    const fromDataAttr = () => {
      const all = document.querySelectorAll('code[data-code-text]');
      if (all.length === 0) return null;
      const last = all.item(all.length - 1) as HTMLElement | null;
      return last?.getAttribute?.('data-code-text') ?? null;
    };
    const fromPre = () => {
      const codeEls = document.querySelectorAll('pre code');
      if (codeEls.length === 0) return null;
      const raw = codeEls.item(codeEls.length - 1)?.textContent ?? '';
      return raw.length > 0 ? raw : null;
    };
    return (
      findCodeInPre(btn) ||
      findCodeNearHeader(btn) ||
      findInMessageContainer(btn) ||
      searchAncestorForCode(btn, 6) ||
      fromDataAttr() ||
      fromPre() ||
      (lastCodeId ? (codeTextRegistry.get(lastCodeId) ?? null) : null)
    );
  }

  const deriveCodeFromDom = (): string | null => {
    try {
      const btn = buttonRef.current;
      if (!btn) return null;
      const header = btn.closest('.aui-code-header-root');
      return getFromNeighbor(header) || getFromMessageContainer(btn) || getFromHeuristics(btn);
    } catch {
      return null;
    }
  };

  const onCopy = () => {
    if (isCopied) return;
    const text = (code && String(code)) || deriveCodeFromDom();
    if (!text) return;
    copyToClipboard(text);
  };
  return (
    <div className="aui-code-header-root">
      <span className="aui-code-header-language">{language}</span>
      <button
        type="button"
        className="aui-button aui-button-ghost aui-button-icon"
        ref={buttonRef}
        onClick={onCopy}
        aria-label="Copy code"
        data-testid="code-copy"
      >
        <span className="aui-sr-only">Copy code</span>
        {isCopied ? '✓' : '⧉'}
      </button>
    </div>
  );
}

function useCopyToClipboard({ copiedDuration = 2000 } = {}) {
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = (value: string) => {
    if (!value) return;
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
  code: function Code(props: unknown) {
    const isMarkdownBlock = useIsMarkdownCodeBlock();
    const { children, className } = (props ?? {}) as { children?: ReactNode; className?: string };
    const text = extractText(children);
    const treatAsBlock = isMarkdownBlock || text.includes('\n');
    const cls = !treatAsBlock
      ? ['aui-md-inline-code', className].filter(Boolean).join(' ')
      : className;
    if (treatAsBlock) {
      const id = nextCodeId();
      codeTextRegistry.set(id, text);
      lastCodeId = id;
      return (
        <div className="aui-code-block">
          <CodeHeader language={''} code={text} />
          <pre>
            <code className={cls} data-code-text={text} data-code-id={id}>
              {children}
            </code>
          </pre>
        </div>
      );
    }
    return <code className={cls}>{children}</code>;
  },
  // biome-ignore lint/style/useNamingConvention: assistant-ui expects "CodeHeader" key
  CodeHeader,
});

function extractText(children: ReactNode | undefined): string {
  if (children == null) return '';
  if (typeof children === 'string') return children;
  if (typeof children === 'number' || typeof children === 'bigint') return String(children);
  if (Array.isArray(children)) {
    const parts: string[] = [];
    for (const child of children) {
      if (typeof child === 'string') parts.push(child);
      else if (typeof child === 'number' || typeof child === 'bigint') parts.push(String(child));
    }
    return parts.join('');
  }
  // For non-string/array, fall back to textContent-like behavior
  try {
    return String(children);
  } catch {
    return '';
  }
}
