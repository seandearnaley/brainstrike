import { useEffect, useId, useRef, useState } from 'react';

/** Lazy mermaid loader hoisted to module scope: keeps the dynamic-import bundle
 * boundary (~1MB, first diagram only) while removing the in-component
 * `import(...)` expression the React Compiler cannot lower. */
const loadMermaid = () => import('mermaid');

type MermaidState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly svg: string }
  | { readonly kind: 'error'; readonly message: string };

/** Lazy mermaid renderer for ```mermaid fences. The mermaid module (~1MB) loads
 * on first diagram only. A parse/render failure shows the error AND the source
 * (Obsidian-style) — a broken diagram must say why. */
export function MermaidBlock({ code }: { readonly code: string }) {
  const [state, setState] = useState<MermaidState>({ kind: 'loading' });
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Stable per-instance id for mermaid.render's target element. useId wraps
  // its ids in characters that are invalid in the CSS selector mermaid/d3
  // builds from this id (':' on React 18, '«»' on React 19), so keep only
  // selector-safe characters. The component is remounted per `code` (keyed in
  // markdown-surface), so each diagram gets a distinct id without a
  // module-level counter.
  const renderId = `brainstrike-mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;

  // biome-ignore lint/plugin/react-effects: async mermaid.render result (loading -> ready/error) cannot be computed during render. This component is remounted per `code` (keyed in markdown-surface), so the initial `loading` state covers every new diagram — no in-effect reset needed.
  useEffect(() => {
    let active = true;
    const id = renderId;
    loadMermaid()
      .then(async ({ default: mermaid }) => {
        const dark = document.documentElement.classList.contains('dark');
        mermaid.initialize({
          layout: 'dagre',
          look: 'classic',
          securityLevel: 'strict',
          startOnLoad: false,
          theme: dark ? 'dark' : 'default',
        });
        const { svg } = await mermaid.render(id, code);
        if (active) {
          setState({ kind: 'ready', svg });
        }
      })
      .catch((error: unknown) => {
        // mermaid.render can leave a residual error element in <body> — remove it.
        document.getElementById(id)?.remove();
        if (active) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [code, renderId]);

  if (state.kind === 'error') {
    return (
      <div
        className="not-prose rounded-md border border-destructive/40 p-3 text-sm"
        data-testid="mermaid-error"
      >
        <p className="mb-2 font-medium text-destructive">Mermaid diagram failed: {state.message}</p>
        <pre className="overflow-x-auto rounded bg-muted p-2 text-muted-foreground text-xs">
          {code}
        </pre>
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div className="not-prose rounded-md bg-muted/50 p-3 text-muted-foreground text-sm">
        Rendering diagram…
      </div>
    );
  }
  return (
    <div
      className="not-prose overflow-x-auto"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid output rendered under securityLevel 'strict' (sanitized by mermaid)
      dangerouslySetInnerHTML={{ __html: state.svg }}
      data-testid="mermaid-diagram"
      ref={hostRef}
    />
  );
}
