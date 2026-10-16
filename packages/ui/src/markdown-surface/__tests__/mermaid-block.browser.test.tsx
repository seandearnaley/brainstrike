import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MarkdownSurface } from '../markdown-surface';

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

function mountDiagram(code: string) {
  return render(
    <MarkdownSurface
      onOpenLink={vi.fn()}
      resolveImageSrc={async () => {
        throw new Error('This diagram fixture has no admitted image resources');
      }}
      value={`Inline math: $x^2$.\n\n\`\`\`mermaid\n${code}\n\`\`\``}
    />
  );
}

async function renderedSvg(): Promise<SVGSVGElement> {
  await waitFor(
    () => {
      expect(screen.queryByTestId('mermaid-error')).toBeNull();
      expect(screen.getByTestId('mermaid-diagram').querySelector('svg')).not.toBeNull();
    },
    { timeout: 10_000 }
  );
  const svg = screen.getByTestId('mermaid-diagram').querySelector('svg');
  if (!svg) {
    throw new Error('The real Mermaid renderer returned no SVG');
  }
  return svg;
}

it.each(['light', 'dark'])(
  'renders real diagram and markdown math together in %s mode',
  async (theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const view = mountDiagram('flowchart LR\n  A["$$E=mc^2$$"] --> B["Result"]');
    const svg = await renderedSvg();
    expect(svg.textContent).toContain('Result');
    expect(svg.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(svg.getBoundingClientRect().height).toBeGreaterThan(0);
    const diagramMath = svg.querySelector('.katex');
    const markdownMath = view.container.querySelector('p .katex');
    expect(diagramMath).not.toBeNull();
    expect(markdownMath).not.toBeNull();
    expect(diagramMath?.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(markdownMath?.getBoundingClientRect().width).toBeGreaterThan(0);
  }
);

it('keeps script links and handlers inert when a diagram tries to loosen security', async () => {
  mountDiagram(`%%{init: {"securityLevel":"loose"}}%%
flowchart LR
  A["<b onclick='alert(1)'>Untrusted</b>"] --> B["Result"]
  click A "javascript:alert(1)"`);
  const svg = await renderedSvg();
  expect(svg.querySelector('script, [onclick], [onerror]')).toBeNull();
  for (const anchor of svg.querySelectorAll('a')) {
    expect(anchor.getAttribute('href')).not.toEqual(expect.stringMatching(/^\s*javascript:/i));
    expect(anchor.getAttribute('xlink:href')).not.toEqual(
      expect.stringMatching(/^\s*javascript:/i)
    );
  }
});
