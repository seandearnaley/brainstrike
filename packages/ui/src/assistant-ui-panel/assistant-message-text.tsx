import { memo, useEffect, useState } from 'react';

type MarkdownTextComponent = typeof import('./markdown-text').MarkdownText;

let markdownTextComponent: MarkdownTextComponent | null = null;
let markdownTextComponentPromise: Promise<MarkdownTextComponent> | null = null;

async function loadMarkdownTextComponent(): Promise<MarkdownTextComponent> {
  if (markdownTextComponent) {
    return markdownTextComponent;
  }
  if (!markdownTextComponentPromise) {
    markdownTextComponentPromise = import('./markdown-text').then((module) => {
      markdownTextComponent = module.MarkdownText;
      return module.MarkdownText;
    });
  }
  return markdownTextComponentPromise;
}

export async function preloadMarkdownText(): Promise<void> {
  await loadMarkdownTextComponent();
}

export const AssistantMessageText = memo(function AssistantMessageText() {
  const [LoadedComponent, setLoadedComponent] = useState<MarkdownTextComponent | null>(
    markdownTextComponent
  );

  useEffect(() => {
    if (LoadedComponent) {
      return;
    }

    let cancelled = false;
    void loadMarkdownTextComponent().then((component) => {
      if (!cancelled) {
        setLoadedComponent(() => component);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [LoadedComponent]);

  if (LoadedComponent) {
    return <LoadedComponent />;
  }

  return <div className="aui-md animate-pulse text-muted-foreground/70">Loading message…</div>;
});
