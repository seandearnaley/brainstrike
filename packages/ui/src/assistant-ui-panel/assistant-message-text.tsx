import { memo, useEffect, useState } from 'react';

type MarkdownModule = typeof import('./markdown-text');
type MarkdownVariant = 'MarkdownText' | 'UserMarkdownText';
type MarkdownTextComponent = MarkdownModule[MarkdownVariant];

let markdownModule: MarkdownModule | null = null;
let markdownModulePromise: Promise<MarkdownModule> | null = null;

async function loadMarkdownModule(): Promise<MarkdownModule> {
  if (markdownModule) {
    return markdownModule;
  }
  if (!markdownModulePromise) {
    markdownModulePromise = import('./markdown-text').then((module) => {
      markdownModule = module;
      return module;
    });
  }
  return markdownModulePromise;
}

export async function preloadMarkdownText(): Promise<void> {
  await loadMarkdownModule();
}

function useMarkdownTextComponent(variant: MarkdownVariant): MarkdownTextComponent | null {
  const [component, setComponent] = useState<MarkdownTextComponent | null>(
    markdownModule?.[variant] ?? null
  );

  useEffect(() => {
    if (component) {
      return;
    }

    let cancelled = false;
    void loadMarkdownModule().then((module) => {
      if (!cancelled) {
        setComponent(() => module[variant]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [component, variant]);

  return component;
}

function MarkdownTextFallback() {
  return <div className="aui-md animate-pulse text-muted-foreground/70">Loading message…</div>;
}

/** Assistant-authored text parts. Provider citation markers are stripped. */
export const AssistantMessageText = memo(function AssistantMessageText() {
  const LoadedComponent = useMarkdownTextComponent('MarkdownText');

  return LoadedComponent ? <LoadedComponent /> : <MarkdownTextFallback />;
});

/**
 * User-authored text parts, rendered verbatim. A separate component rather than
 * a role check inside the renderer, so the two call sites in
 * assistant-ui-panel.tsx state plainly which text is normalized and which is not.
 */
export const UserMessageText = memo(function UserMessageText() {
  const LoadedComponent = useMarkdownTextComponent('UserMarkdownText');

  return LoadedComponent ? <LoadedComponent /> : <MarkdownTextFallback />;
});
