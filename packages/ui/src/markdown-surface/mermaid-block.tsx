import { ParseError, render as renderTex } from 'katex';
import { type MathMarkup, type Mounted, mountAsync } from 'pele/lazy';
import { useEffect, useRef, useState } from 'react';

/** Typesets `$$…$$` diagram labels with the KaTeX the Markdown math uses
 * (default `trust: false`). Pele sizes each label from the returned box, so the
 * MathML is measured in a hidden probe at the label's font size, and only the
 * `<math>` element is returned (Pele's KaTeX guidance). Malformed TeX returns
 * null, which leaves the TeX source visible in the label. */
function typesetMath(tex: string, size: number): MathMarkup | null {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;left:-9999px;visibility:hidden;display:inline-block;white-space:nowrap;font-size:${size}px`;
  document.body.append(probe);
  try {
    renderTex(tex, probe, { displayMode: true, output: 'mathml' });
    const expression = probe.querySelector('math');
    if (!expression) {
      return null;
    }
    const { height, width } = expression.getBoundingClientRect();
    return { height, html: expression.outerHTML, width };
  } catch (error) {
    if (error instanceof ParseError) {
      return null;
    }
    throw error;
  } finally {
    probe.remove();
  }
}

/** Renders a ```mermaid fence with Pele. Pele owns the host's DOM: it lays the
 * diagram out for the container width, redraws on resize and web-font loads,
 * and shows a parse error (message plus the marked source line) in place of
 * the diagram — a broken diagram must say why. Colors come from the `.pele`
 * rules in globals.css, so theme switches restyle without a re-render. Each
 * diagram type loads on first use. */
export function MermaidBlock({ code }: { readonly code: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Remounted per `code` (keyed in markdown-surface), so each mount draws one source.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    let active = true;
    let diagram: Mounted | undefined;
    mountAsync(host, code, { math: typesetMath })
      .then((mounted) => {
        diagram = mounted;
        if (!active) {
          mounted.destroy();
        }
      })
      .catch((error: unknown) => {
        // Only loading the diagram type's chunk rejects; draw errors show in the host.
        if (active) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      active = false;
      diagram?.destroy();
    };
  }, [code]);

  if (loadError !== null) {
    return (
      <p className="not-prose text-destructive text-sm" data-testid="mermaid-error">
        Diagram renderer failed to load: {loadError}
      </p>
    );
  }
  return <div className="not-prose" data-testid="mermaid-diagram" ref={hostRef} />;
}
