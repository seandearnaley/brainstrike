import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { MarkdownSurface } from '../markdown-surface';

afterEach(async () => {
  cleanup();
  document.documentElement.classList.remove('dark');
  await page.viewport(1280, 800);
});

function markdownValue(code: string, inline = String.raw`\frac{a+b}{c} + \sqrt{x}`) {
  return `Inline math: $${inline}$.\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\n\`\`\`mermaid\n${code}\n\`\`\``;
}

function surface(value: string) {
  return (
    <MarkdownSurface
      onOpenLink={vi.fn()}
      resolveImageSrc={async () => {
        throw new Error('This math fixture has no admitted image resources');
      }}
      value={value}
    />
  );
}

function mountDiagram(code: string) {
  return render(surface(markdownValue(code)));
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

it.each([
  { theme: 'light', width: 1280 },
  { theme: 'dark', width: 1280 },
  { theme: 'light', width: 390 },
  { theme: 'dark', width: 390 },
])(
  'renders styled markdown and diagram math in $theme mode at $width px',
  async ({ theme, width }) => {
    await page.viewport(width, 800);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const code = 'flowchart LR\n  A["$$E=mc^2$$"] --> B["Result"]';
    const view = mountDiagram(code);
    const svg = await renderedSvg();
    await document.fonts.ready;
    expect(svg.textContent).toContain('Result');
    expect(svg.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(svg.getBoundingClientRect().height).toBeGreaterThan(0);
    // Chromium takes Mermaid's native MathML path; test its actual output.
    expect(svg.querySelector('.katex math')?.getBoundingClientRect().width).toBeGreaterThan(0);
    for (const selector of ['p .katex', '.katex-display .katex']) {
      const math = view.container.querySelector(selector);
      if (!math) {
        throw new Error(`Missing rendered math: ${selector}`);
      }
      const base = math.querySelector('.katex-html .katex-base');
      const mathml = math.querySelector('.katex-mathml');
      if (!(base && mathml)) {
        throw new Error('Missing KaTeX HTML/MathML structure');
      }
      expect(getComputedStyle(base).display).toBe('inline-block');
      expect(getComputedStyle(mathml).position).toBe('absolute');
      expect(base.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(base.getBoundingClientRect().height).toBeGreaterThan(0);
    }
    for (const family of ['KaTeX_Main', 'KaTeX_Math']) {
      expect(
        [...document.fonts].some((font) => font.family === family && font.status === 'loaded')
      ).toBe(true);
    }
    view.rerender(surface(markdownValue(code, String.raw`\sqrt{y+1}`)));
    expect(view.container.querySelector('p annotation')?.textContent).toBe(String.raw`\sqrt{y+1}`);
    expect(
      view.container.querySelector('p .katex-html')?.getBoundingClientRect().width
    ).toBeGreaterThan(0);
  }
);

it('shows malformed math and keeps untrusted math extensions inert', () => {
  const view = render(
    surface(String.raw`Bad: $\frac{$.

Unsafe: $\href{javascript:alert(1)}{unsafe}$ and $\includegraphics{https://example.invalid/image.png}$ and $\htmlClass{owned}{x}$.`)
  );
  const error = view.container.querySelector('.katex-error');
  expect(error?.textContent).toBe(String.raw`\frac{`);
  expect(error?.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(view.container.querySelector('a, img, script, .owned')).toBeNull();
  expect(view.container.textContent).toContain('unsafe');
});

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
