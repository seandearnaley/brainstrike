import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { AssistantActivityGroup } from '../assistant-ui-panel/assistant-activity-group';
import type { ToolActivitySummary } from '../assistant-ui-panel/tool-activity';
import { CodeBlockBody } from '../code-block/code-block-body';
import { CodeBlockHeader } from '../code-block/code-block-header';
import { TooltipProvider } from '../tooltip';
// Theme variables (colors, shimmer, tints) so screenshots render faithfully.
import '../globals.css';
import '../assistant-ui-panel/overrides.css';

/**
 * Reproduce the real app's CSS baseline: Tailwind v4 preflight zeroes element
 * margins and strips list styling via a universal-selector reset that ships
 * INSIDE `@layer base` (repo cascade rule: preflight is layered; unlayered
 * universal resets are forbidden). The markdown typography fix and the shared
 * code-block metrics must win over this (they do — unlayered overrides.css
 * rules beat any layer, and the globals.css @layer base element rules
 * out-specify the universal reset within the same layer), which is exactly
 * what these real-Chromium assertions prove.
 */
const PREFLIGHT_RESET = `
  @layer base {
    *, ::before, ::after { margin: 0; padding: 0; }
    ul, ol { list-style: none; }
  }
`;

beforeAll(() => {
  const style = document.createElement('style');
  style.id = 'preflight-reset';
  style.textContent = PREFLIGHT_RESET;
  document.head.prepend(style);
});

afterEach(() => {
  document.body.replaceChildren();
});

const activeSummary: ToolActivitySummary = {
  activeArg: 'packages/db/src/registry.ts',
  activeLabel: 'brainstrike.grepSearch',
  failedCount: 0,
  runningCount: 1,
  stepCount: 3,
};

const doneSummary: ToolActivitySummary = {
  activeArg: null,
  activeLabel: null,
  failedCount: 0,
  runningCount: 0,
  stepCount: 5,
};

describe('markdown typography (real browser, with preflight reset)', () => {
  test('restores paragraph, list, and heading spacing that preflight removed', () => {
    render(
      <div className="assistant-ui-panel">
        <div className="aui-md">
          <p data-testid="p1">First paragraph.</p>
          <p data-testid="p2">Second paragraph should be visually separated.</p>
          <ul>
            <li data-testid="li1">bullet one</li>
            <li>bullet two</li>
          </ul>
          <h2 data-testid="h2">A heading</h2>
        </div>
      </div>
    );

    const secondParagraph = screen.getByTestId('p2');
    const list = secondParagraph.parentElement?.querySelector('ul');
    const listItem = screen.getByTestId('li1');
    const heading = screen.getByTestId('h2');

    // The bug: bare <p> fell through to preflight margin:0 → cramped.
    // The fix: a non-zero vertical margin separates paragraphs again.
    const pMarginTop = Number.parseFloat(getComputedStyle(secondParagraph).marginTop);
    expect(pMarginTop).toBeGreaterThan(0);

    // Preflight strips list-style + indent; the fix restores both.
    if (!list) {
      throw new Error('expected a <ul> inside the markdown body');
    }
    expect(getComputedStyle(list).listStyleType).toBe('disc');
    expect(Number.parseFloat(getComputedStyle(list).paddingLeft)).toBeGreaterThan(0);
    expect(Number.parseFloat(getComputedStyle(listItem).marginTop)).toBeGreaterThan(0);

    // Headings regain weight and vertical breathing room.
    expect(getComputedStyle(heading).fontWeight).toBe('600');
    expect(Number.parseFloat(getComputedStyle(heading).marginTop)).toBeGreaterThan(0);
  });

  test('first child has no leading margin (no double gap above the answer)', () => {
    render(
      <div className="assistant-ui-panel">
        <div className="aui-md">
          <p data-testid="first">Leading paragraph.</p>
        </div>
      </div>
    );
    expect(getComputedStyle(screen.getByTestId('first')).marginTop).toBe('0px');
  });

  test('styles the bare fallback code block (Shiki loading/failure) with a container', () => {
    render(
      <div className="assistant-ui-panel">
        <div className="aui-md">
          <pre data-testid="fallback-pre">
            <code>const x = 1;</code>
          </pre>
        </div>
      </div>
    );
    const pre = screen.getByTestId('fallback-pre');
    // A real container: non-zero padding + a non-transparent background.
    expect(Number.parseFloat(getComputedStyle(pre).paddingTop)).toBeGreaterThan(0);
    expect(getComputedStyle(pre).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(pre).overflowX).toBe('auto');
  });
});

describe('shared code-block chrome (real browser)', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  const renderChatBlock = (code: string, language: string) =>
    render(
      <TooltipProvider>
        <div className="assistant-ui-panel">
          <div className="aui-md">
            {/* Chat pipeline contract: header and body render as SIBLINGS. */}
            <CodeBlockHeader code={code} language={language} />
            <CodeBlockBody code={code} language={language} />
          </div>
        </div>
      </TooltipProvider>
    );

  test('header and body halves carry the shared box-class contract', () => {
    // Tailwind utilities are not compiled in this test bundle, so the box
    // chrome is asserted as the class contract the app build styles.
    const { container } = renderChatBlock('const x = 1;', 'typescript');

    const header = container.querySelector('.bs-code-block-header');
    const body = container.querySelector('.bs-code-block-body');
    if (!(header && body)) {
      throw new Error('expected both code-block halves to render');
    }

    // Header: rounded top, open bottom (the seam is a single border).
    for (const cls of ['rounded-t-md', 'border', 'border-b-0']) {
      expect(header.classList.contains(cls)).toBe(true);
    }
    // Body: rounded bottom, open top, horizontal scroll inside the box.
    for (const cls of ['rounded-b-md', 'border', 'border-t-0', 'overflow-x-auto']) {
      expect(body.classList.contains(cls)).toBe(true);
    }
  });

  test('fallback <pre> and resolved Shiki share metrics (zero-shift swap), no stray language label', async () => {
    // The Shiki singleton may already be cached from an earlier test, so the
    // pre-highlight state cannot be observed on the same block. Instead mount
    // a deterministic fallback (empty code never renders Shiki) next to a
    // real highlighted block and require identical computed metrics — this is
    // exactly the streamed-swap geometry.
    const { container } = render(
      <TooltipProvider>
        <div className="assistant-ui-panel">
          <div className="aui-md">
            <div data-testid="fallback-block">
              <CodeBlockBody code="" language="typescript" />
            </div>
            <div data-testid="highlighted-block">
              <CodeBlockBody code={'const answer = 42;\n'} language="typescript" />
            </div>
          </div>
        </div>
      </TooltipProvider>
    );

    const fallbackPre = container.querySelector('[data-testid="fallback-block"] pre');
    if (!fallbackPre) {
      throw new Error('expected the fallback <pre>');
    }
    const fallbackStyle = getComputedStyle(fallbackPre);
    const fallbackPadding = Number.parseFloat(fallbackStyle.paddingTop);
    expect(fallbackPadding).toBeGreaterThan(0);
    expect(Number.parseFloat(fallbackStyle.marginTop)).toBe(0);
    expect(Number.parseFloat(fallbackStyle.marginBottom)).toBe(0);

    // Real Shiki (wasm) resolves in-browser and renders <pre class="shiki">.
    const shikiPre = await waitFor(
      () => {
        const pre = container.querySelector('[data-testid="highlighted-block"] pre.shiki');
        if (!pre) {
          throw new Error('shiki not resolved yet');
        }
        return pre;
      },
      { timeout: 15_000 }
    );

    const shikiStyle = getComputedStyle(shikiPre);
    expect(Number.parseFloat(shikiStyle.paddingTop)).toBe(fallbackPadding);
    expect(Number.parseFloat(shikiStyle.fontSize)).toBe(Number.parseFloat(fallbackStyle.fontSize));
    expect(shikiStyle.lineHeight).toBe(fallbackStyle.lineHeight);
    expect(Number.parseFloat(shikiStyle.marginTop)).toBe(0);
    expect(shikiStyle.overflowX).toBe('auto');

    // react-shiki's own label is disabled — the header owns the language text.
    expect(container.querySelector('[data-slot="language-label"]')).toBeNull();
  }, 20_000);

  test('dark mode: shiki tokens actually take the dark palette', async () => {
    document.documentElement.classList.add('dark');
    const { container } = renderChatBlock('const answer = 42;\n', 'typescript');

    const shikiPre = await waitFor(
      () => {
        const pre = container.querySelector('pre.shiki');
        if (!pre) {
          throw new Error('shiki not resolved yet');
        }
        return pre;
      },
      { timeout: 15_000 }
    );

    const tokenSpan = shikiPre.querySelector<HTMLElement>('span[style*="--shiki-dark"]');
    if (!tokenSpan) {
      throw new Error('expected a dual-theme token span');
    }
    const declaredDark = tokenSpan.style.getPropertyValue('--shiki-dark').trim();
    const probe = document.createElement('span');
    probe.style.color = declaredDark;
    document.body.append(probe);
    const expectedColor = getComputedStyle(probe).color;
    probe.remove();

    expect(getComputedStyle(tokenSpan).color).toBe(expectedColor);
  }, 20_000);
});

describe('AssistantActivityGroup (real browser)', () => {
  test('active turn: live "Working" heartbeat, current tool, expanded body', () => {
    render(
      <div className="assistant-ui-panel">
        <AssistantActivityGroup isActive summary={activeSummary}>
          <div data-testid="tool-rows">tool rows</div>
        </AssistantActivityGroup>
      </div>
    );

    expect(screen.getByTestId('assistant-activity-working')).toHaveTextContent('Working');
    expect(screen.getByText(/brainstrike\.grepSearch/)).toBeVisible();
    expect(screen.getByText(/registry\.ts/)).toBeVisible();
    expect(screen.getByTestId('assistant-activity-body')).toBeVisible();

    // The panel chrome actually rendered (CSS applied in a real browser).
    const group = screen.getByTestId('assistant-activity-group');
    expect(group).toHaveAttribute('data-active', 'true');
    expect(Number.parseFloat(getComputedStyle(group).borderRadius)).toBeGreaterThan(0);
  });

  test('done turn: auto-collapsed summary that expands on click', async () => {
    const user = userEvent.setup();
    render(
      <div className="assistant-ui-panel">
        <AssistantActivityGroup fallbackMs={12_000} isActive={false} summary={doneSummary}>
          <div data-testid="tool-rows">tool rows</div>
        </AssistantActivityGroup>
      </div>
    );

    expect(screen.getByText('Worked')).toBeVisible();
    expect(screen.getByText(/for 12\.0s/)).toBeVisible();
    expect(screen.getByText(/5 steps/)).toBeVisible();

    // Auto-collapsed when done: the body is hidden (display:none via [hidden]).
    const body = screen.getByTestId('assistant-activity-body');
    expect(body).not.toBeVisible();

    // User can expand it.
    await user.click(screen.getByTestId('assistant-activity-summary'));
    expect(body).toBeVisible();
  });

  test('failed turn renders the failed treatment', () => {
    render(
      <div className="assistant-ui-panel">
        <AssistantActivityGroup isActive={false} summary={{ ...doneSummary, failedCount: 2 }} />
      </div>
    );
    const group = screen.getByTestId('assistant-activity-group');
    expect(group).toHaveAttribute('data-failed', 'true');
    expect(screen.getByText('Activity failed')).toBeVisible();
  });
});
