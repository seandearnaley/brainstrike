import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import './mermaid-block.browser.css';
import { TooltipProvider } from '../../tooltip';
import { DiagramFullSizeContainerContext } from '../diagram-full-size-container';
import { MarkdownSurface } from '../markdown-surface';
import { MermaidBlock } from '../mermaid-block';

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
    throw new Error('Pele drew no SVG');
  }
  return svg;
}

/** The computed color an app theme token resolves to right now. */
function tokenColor(token: string): string {
  const probe = document.createElement('span');
  probe.style.color = `hsl(var(${token}))`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
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
    // The label's math is KaTeX MathML, measured and placed by Pele.
    expect(svg.querySelector('math')?.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(svg.textContent).not.toContain('$$');
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

it('colors the diagram from the app theme and follows a theme switch without redrawing', async () => {
  render(surface('```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```'));
  const svg = await renderedSvg();
  const node = svg.querySelector('rect');
  const label = svg.querySelector('text');
  if (!(node && label)) {
    throw new Error('Pele drew no node');
  }
  expect(getComputedStyle(label).fill).toBe(tokenColor('--foreground'));
  expect(getComputedStyle(node).fill).toBe(tokenColor('--muted'));
  const lightText = getComputedStyle(label).fill;

  document.documentElement.classList.add('dark');
  expect(screen.getByTestId('mermaid-diagram').querySelector('svg')).toBe(svg);
  expect(getComputedStyle(label).fill).toBe(tokenColor('--foreground'));
  expect(getComputedStyle(node).fill).toBe(tokenColor('--muted'));
  expect(getComputedStyle(label).fill).not.toBe(lightText);
});

it('shows why a malformed diagram cannot be drawn', async () => {
  render(surface('```mermaid\nflowchart LR\n  A --> \n```'));
  await waitFor(() => {
    expect(screen.getByTestId('mermaid-diagram').textContent).toContain('Parse error on line 2');
  });
  const host = screen.getByTestId('mermaid-diagram');
  expect(host.querySelector('svg')).toBeNull();
  expect(host.getBoundingClientRect().height).toBeGreaterThan(0);
});

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
    expect(anchor.getAttribute('href')).not.toEqual(expect.stringMatching(/^\s*javascript:/iu));
    expect(anchor.getAttribute('xlink:href')).not.toEqual(
      expect.stringMatching(/^\s*javascript:/iu)
    );
  }
});

async function pngPixels(png: Blob) {
  const bitmap = await createImageBitmap(png);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('No 2D context');
  }
  context.drawImage(bitmap, 0, 0);
  return { context, height: bitmap.height, width: bitmap.width };
}

function rgb(color: string): [number, number, number] {
  const channels = color.match(/\d+(\.\d+)?/gu)?.map(Number) ?? [];
  return [channels[0] ?? -1, channels[1] ?? -1, channels[2] ?? -1];
}

it.each(['light', 'dark'])(
  'exports a standalone %s-theme diagram as SVG and as a PNG at the chosen scale',
  async (theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    render(surface('```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```'));
    const live = await renderedSvg();
    const svg = live.outerHTML;
    const { diagramPng, standaloneDiagram } = await import('../mermaid-export');
    const { width, height } = live.viewBox.baseVal;

    const diagram = await standaloneDiagram(live, { height, svg, width }, 'theme');
    // Detached from the page, the copy still has the theme's colours.
    const detached = new DOMParser().parseFromString(diagram.svg, 'image/svg+xml');
    expect(detached.documentElement.getAttribute('width')).toBe(String(width));
    expect(detached.documentElement.style.getPropertyValue('--pele-bg')).not.toBe('');

    const png = await diagramPng(diagram, 2);
    const pixels = await pngPixels(png);
    expect(pixels.width).toBe(Math.round(width * 2));
    expect(pixels.height).toBe(Math.round(height * 2));
    const corner = [...pixels.context.getImageData(1, 1, 1, 1).data.slice(0, 3)];
    const background = rgb(tokenColor('--background'));
    corner.forEach((channel, index) => {
      expect(Math.abs(channel - (background[index] ?? -1))).toBeLessThanOrEqual(2);
    });

    const transparent = await diagramPng(
      await standaloneDiagram(live, { height, svg, width }, 'transparent'),
      1
    );
    const clear = await pngPixels(transparent);
    expect(clear.context.getImageData(1, 1, 1, 1).data[3]).toBe(0);
  }
);

it('opens the diagram full size over its container and closes it with Escape or Close', async () => {
  const user = userEvent.setup();
  const panel = document.createElement('div');
  panel.style.cssText = 'position:relative;width:900px;height:600px';
  document.body.append(panel);
  // StrictMode, as in the app: the replayed mount must not unseat the zoom buttons.
  render(
    <StrictMode>
      <TooltipProvider>
        <DiagramFullSizeContainerContext.Provider value={panel}>
          <MermaidBlock code={'flowchart LR\n  A[Start] --> B[End]'} />
        </DiagramFullSizeContainerContext.Provider>
      </TooltipProvider>
    </StrictMode>
  );
  await renderedSvg();
  const open = screen.getByRole('button', { name: 'Full size' });
  await user.click(open);

  const view = await screen.findByRole('dialog', { name: 'Diagram' });
  expect(panel.contains(view)).toBe(true);
  expect(view.getBoundingClientRect()).toMatchObject({ height: 600, width: 900 });
  await waitFor(() => expect(view.querySelector('svg.pele')).not.toBeNull());

  // The zoom buttons sit inside the diagram's area, clear of the header.
  const header = within(view).getByRole('button', { name: 'Close' }).parentElement;
  const canvas = within(view).getByTestId('mermaid-diagram').getBoundingClientRect();
  const zoomIn = within(view).getByRole('button', { name: 'Zoom in' }).getBoundingClientRect();
  expect(zoomIn.top).toBeGreaterThanOrEqual(header?.getBoundingClientRect().bottom ?? 0);
  expect(zoomIn.bottom).toBeLessThanOrEqual(canvas.bottom);

  // The panel's resize reaches the full-size diagram.
  panel.style.width = '1200px';
  await waitFor(() => expect(view.getBoundingClientRect().width).toBe(1200));

  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(open).toHaveFocus();

  // The visible Close button leaves too.
  await user.click(open);
  const reopened = await screen.findByRole('dialog', { name: 'Diagram' });
  await user.click(within(reopened).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(open).toHaveFocus();
  panel.remove();
});
