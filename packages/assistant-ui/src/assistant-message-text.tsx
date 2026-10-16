import { MessagePartPrimitive } from '@assistant-ui/react';
import { type MemoExoticComponent, memo, type ReactElement, useEffect, useState } from 'react';

type MarkdownModule = typeof import('./markdown-text');
type MarkdownTextComponent = MarkdownModule['MarkdownText'];

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

/**
 * Build the lazy wrapper for one markdown variant AT MODULE SCOPE.
 *
 * The `useState` + `useEffect` pair stays inlined in the returned component
 * rather than being lifted into a shared hook: `react-hooks/static-components`
 * cannot see through a custom hook's return value and flags the rendered
 * `<LoadedComponent />` as a component created during render.
 */
function createLazyMarkdownText(displayName: string): MemoExoticComponent<() => ReactElement> {
  const LazyMarkdownText = memo(function LazyMarkdownText() {
    const [LoadedComponent, setLoadedComponent] = useState<MarkdownTextComponent | null>(
      markdownModule?.MarkdownText ?? null
    );

    useEffect(() => {
      if (LoadedComponent) {
        return;
      }

      let cancelled = false;
      void loadMarkdownModule().then((module) => {
        if (!cancelled) {
          setLoadedComponent(() => module.MarkdownText);
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
  LazyMarkdownText.displayName = displayName;

  return LazyMarkdownText;
}

/** Assistant-authored text parts. Provider citation markers are stripped. */
export const AssistantMessageText = createLazyMarkdownText('AssistantMessageText');

/**
 * User-authored text parts, shown exactly as typed: plain text with whitespace
 * kept, never markdown (owner decision 2026-10-16; a prompt naming double-star
 * credential globs rendered as bold). Nothing is stripped or normalized, so a pasted
 * citation marker or Nerd Fonts glyph stays as the user sent it. A separate
 * component rather than a role check inside the renderer, so the call sites
 * state plainly which text is normalized and which is not.
 */
export const UserMessageText = memo(function UserMessageText(): ReactElement {
  return (
    <MessagePartPrimitive.Text
      className="whitespace-pre-wrap break-words"
      component="p"
      smooth={false}
    />
  );
});
