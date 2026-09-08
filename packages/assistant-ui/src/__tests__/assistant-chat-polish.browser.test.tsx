import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@brainstrike/ui';
import { CodeBlockBody, CodeBlockHeader } from '@brainstrike/ui/code-block';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { AssistantActivityGroup } from '../assistant-activity-group';
import { UserMessage } from '../assistant-ui-panel';
import type { ToolActivitySummary } from '../tool-activity';
// Theme variables (colors, shimmer, tints) so screenshots render faithfully.
import '@brainstrike/ui/globals.css';
import '../overrides.css';

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

/**
 * Density pass: vertical rhythm comes from the UNLAYERED overrides.css rules
 * (which always beat Tailwind's layered utilities), so assert the computed
 * values in a real browser rather than class names.
 */
describe('message vertical rhythm (real browser)', () => {
  test('assistant message roots use the compact rhythm from overrides.css', () => {
    render(
      <div className="assistant-ui-panel">
        <div className="bs-thread">
          <div className="aui-thread-viewport">
            <div className="aui-assistant-message-root" data-testid="assistant-root">
              assistant turn
            </div>
            <div className="aui-assistant-message-root" data-testid="assistant-root-last">
              last assistant turn
            </div>
          </div>
        </div>
      </div>
    );

    const root = screen.getByTestId('assistant-root');
    const lastRoot = screen.getByTestId('assistant-root-last');
    // 0.625rem between-message padding; non-last roots keep margin-bottom 0.
    expect(getComputedStyle(root).paddingBottom).toBe('10px');
    expect(getComputedStyle(root).marginBottom).toBe('0px');
    // Last message: 0.75rem margin (down from 1rem) instead of the library's 24rem.
    expect(getComputedStyle(lastRoot).marginBottom).toBe('12px');
  });

  test('user message roots use the compact rhythm from overrides.css', () => {
    render(
      <div className="assistant-ui-panel">
        <div className="bs-thread">
          <div className="aui-thread-viewport">
            <div className="aui-user-message-root" data-testid="user-root">
              user turn
            </div>
            <div className="aui-user-message-root" data-testid="user-root-last">
              last user turn
            </div>
          </div>
        </div>
      </div>
    );

    expect(getComputedStyle(screen.getByTestId('user-root')).marginBottom).toBe('4px');
    expect(getComputedStyle(screen.getByTestId('user-root-last')).marginBottom).toBe('12px');
  });
});

/**
 * Wide-panel real estate: .bs-thread is an inline-size container and message
 * ROOTS (not the viewport) cap at 48rem and center once the panel is wide.
 * Targeting the roots in place (never wrapper divs) keeps them direct children
 * of the scroller.
 */
describe('container-aware message width (real browser)', () => {
  test('wide panel (960px): message roots cap at 48rem and center', () => {
    render(
      <div className="assistant-ui-panel">
        <div className="bs-thread" style={{ width: 960 }}>
          <div className="aui-thread-viewport">
            <div className="aui-assistant-message-root" data-testid="wide-root">
              assistant turn
            </div>
          </div>
        </div>
      </div>
    );

    const root = screen.getByTestId('wide-root');
    expect(getComputedStyle(root).maxWidth).toBe('768px');
    expect(root.getBoundingClientRect().width).toBe(768);
    expect(Number.parseFloat(getComputedStyle(root).marginLeft)).toBeGreaterThan(0);
  });

  test('narrow panel (360px): message roots stay full width with no centering', () => {
    render(
      <div className="assistant-ui-panel">
        <div className="bs-thread" style={{ width: 360 }}>
          <div className="aui-thread-viewport">
            <div className="aui-assistant-message-root" data-testid="narrow-root">
              assistant turn
            </div>
          </div>
        </div>
      </div>
    );

    const root = screen.getByTestId('narrow-root');
    expect(getComputedStyle(root).marginLeft).toBe('0px');
    expect(root.getBoundingClientRect().width).toBe(360);
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
  test('active turn: live "Working" heartbeat + current tool in the header, body collapsed until expanded', async () => {
    const user = userEvent.setup();
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
    // Collapsed by default even while active (BST-1677 wave 3, Sean's
    // request): the header is the live cycler, so the body starts hidden.
    const body = screen.getByTestId('assistant-activity-body');
    expect(body).not.toBeVisible();

    // The panel chrome actually rendered (CSS applied in a real browser).
    const group = screen.getByTestId('assistant-activity-group');
    expect(group).toHaveAttribute('data-active', 'true');
    expect(Number.parseFloat(getComputedStyle(group).borderRadius)).toBeGreaterThan(0);

    // The user can still expand it while active.
    await user.click(screen.getByTestId('assistant-activity-summary'));
    expect(body).toBeVisible();
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

  test('a failed step is counted in the summary without failing the whole group', () => {
    render(
      <div className="assistant-ui-panel">
        {/* Hand-translates the one Tailwind utility this assertion needs
            (this package's own tests never compile Tailwind, see the
            USER_MESSAGE_LAYOUT_SHIM comment above), so the comparison below
            measures the real destructive design token in real Chromium
            rather than hardcoding an expected color string. */}
        <style>{'.text-destructive { color: hsl(var(--destructive)); }'}</style>
        <span className="text-destructive" data-testid="destructive-token-probe" />
        <AssistantActivityGroup isActive={false} summary={{ ...doneSummary, failedCount: 2 }} />
      </div>
    );
    const group = screen.getByTestId('assistant-activity-group');
    expect(group).toHaveAttribute('data-failed', 'false');
    const failedCount = screen.getByTestId('assistant-activity-failed-count');
    expect(failedCount).toBeVisible();
    expect(failedCount).toHaveTextContent('2 failed');
    const destructiveColor = getComputedStyle(screen.getByTestId('destructive-token-probe')).color;
    expect(getComputedStyle(failedCount).color).toBe(destructiveColor);
    expect(screen.queryByText('Activity failed')).not.toBeInTheDocument();
  });
});

/**
 * BST-898: hovering a non-last user message must not grow its row and shift
 * every message below it. This package's OWN tests never compile Tailwind
 * (globals.css deliberately omits `@import "tailwindcss"` -- it ships utility
 * classNames for the CONSUMING app's Tailwind build to compile, see the
 * comment at the top of globals.css), so real CSS Grid / absolute-positioning
 * behavior for those utility classes is invisible here by default. The same
 * way PREFLIGHT_RESET above hand-translates Tailwind's preflight reset, this
 * hand-translates ONLY the utility classes the UserMessage subtree actually
 * uses -- real CSS Grid layout in real Chromium then proves (or disproves)
 * the fix's geometry, independent of the consuming app's Tailwind build.
 */
const USER_MESSAGE_LAYOUT_SHIM = `
  .aui-user-message-root {
    display: grid;
    width: 100%;
    grid-auto-rows: auto;
    grid-template-columns: minmax(48px, 1fr) auto;
    row-gap: 0.5rem;
    padding-block: 0.5rem;
  }
  /* Translated the same way as every other utility below (not hardcoded on
     .aui-user-message-root) so dropping \`relative\` from MessagePrimitive.Root
     actually fails this test -- it is half of the containing-block fix. */
  [class~="relative"] { position: relative; }
  [class~="col-start-1"] { grid-column-start: 1; }
  [class~="col-start-2"] { grid-column-start: 2; }
  [class~="col-end-2"] { grid-column-end: 2; }
  [class~="row-start-2"] { grid-row-start: 2; }
  [class~="row-end-3"] { grid-row-end: 3; }
  [class~="flex"] { display: flex; }
  [class~="flex-col"] { flex-direction: column; }
  [class~="items-end"] { align-items: flex-end; }
  [class~="mt-2"] { margin-top: 0.5rem; }
  [class~="mr-3"] { margin-right: 0.75rem; }
  [class~="data-[floating]:absolute"][data-floating] { position: absolute; }
  [class~="data-[floating]:inset-x-0"][data-floating] { left: 0px; right: 0px; }
  /* Button/icon Tailwind classes (size-6, size-4, ...) aren't compiled here
     either, and this test isn't about Button's own chrome -- only the grid/
     float geometry -- so fix a deterministic 24x24 footprint by aria-label
     instead of hand-translating the whole Button + icon class chain. */
  button[aria-label="Copy message"],
  button[aria-label="Edit message"] {
    display: block;
    width: 24px;
    height: 24px;
  }
`;

describe('user action bar float-on-hover (real browser, BST-898)', () => {
  beforeAll(() => {
    const style = document.createElement('style');
    style.id = 'bst-898-user-message-layout-shim';
    style.textContent = USER_MESSAGE_LAYOUT_SHIM;
    document.head.append(style);
  });

  afterAll(() => {
    document.getElementById('bst-898-user-message-layout-shim')?.remove();
  });

  const twoUserMessageModel: ChatModelAdapter = {
    run: () => Promise.resolve({ content: [], status: { reason: 'stop', type: 'complete' } }),
  };

  function TwoUserMessagesHarness() {
    const initialMessages: readonly ThreadMessageLike[] = [
      { content: [{ text: 'First message', type: 'text' }], role: 'user' },
      { content: [{ text: 'Second message', type: 'text' }], role: 'user' },
    ];
    const runtime = useLocalRuntime(twoUserMessageModel, { initialMessages });

    return (
      <TooltipProvider>
        <AssistantRuntimeProvider runtime={runtime}>
          <div className="assistant-ui-panel">
            <div className="bs-thread">
              <div className="aui-thread-viewport">
                <ThreadPrimitive.Messages
                  components={{
                    AssistantMessage: () => null,
                    UserMessage,
                  }}
                />
              </div>
            </div>
          </div>
        </AssistantRuntimeProvider>
      </TooltipProvider>
    );
  }

  test('hovering the NON-LAST user message floats its action bar at the same spot the in-flow bar occupies on the last message, without growing the row', async () => {
    render(<TwoUserMessagesHarness />);

    // initialMessages hydrate asynchronously (see user-action-bar-copy.test.tsx);
    // the LAST message's bar is always mounted (autohide="not-last" never
    // hides it), so waiting for its Edit button confirms hydration settled.
    await screen.findByRole('button', { name: 'Edit message' });

    const roots = document.querySelectorAll<HTMLElement>('.aui-user-message-root');
    expect(roots).toHaveLength(2);
    const [nonLastRoot, lastRoot] = roots;
    if (!(nonLastRoot && lastRoot)) {
      throw new Error('expected both user message roots');
    }

    // Reference geometry: the LAST message's bar is always mounted IN FLOW
    // (Normal status -- autohide="not-last" never hides it, so it never
    // floats either) -- this is the exact, unambiguous "beside the bubble"
    // spot with no absolute positioning involved at all.
    const lastBar = lastRoot.querySelector<HTMLElement>('[data-testid="user-action-bar"]');
    if (!lastBar) {
      throw new Error('expected the last message bar to be mounted in flow');
    }
    expect(lastBar).not.toHaveAttribute('data-floating');
    const inFlowRect = lastBar.getBoundingClientRect();
    const inFlowTopOffset = inFlowRect.top - lastRoot.getBoundingClientRect().top;

    // Not hovering yet: autohide="not-last" + not hovering => unmounted.
    expect(nonLastRoot.querySelector('[data-testid="user-action-bar"]')).toBeNull();
    const heightBeforeHover = nonLastRoot.getBoundingClientRect().height;

    fireEvent.mouseEnter(nonLastRoot);

    const floatingBar = await waitFor(() => {
      const bar = nonLastRoot.querySelector<HTMLElement>('[data-testid="user-action-bar"]');
      if (!bar) {
        throw new Error('action bar not mounted yet');
      }
      return bar;
    });

    // The fix: it floats (data-floating) instead of mounting in flow, so it
    // never contributes to row 2's auto-sized height.
    expect(floatingBar).toHaveAttribute('data-floating', 'true');
    const heightAfterHover = nonLastRoot.getBoundingClientRect().height;
    expect(heightAfterHover).toBe(heightBeforeHover);

    // Both message roots share identical column geometry (same grid
    // template, same-width thread), so the floating bar's rect must match
    // the in-flow reference bar's rect -- same visual spot, it just no
    // longer contributes to row 2's height. Pins BOTH axes: an abspos grid
    // item with only its START lines definite resolves its END lines (and
    // therefore its containing block) to the grid container's padding
    // edge, not to the col-1/row-2 grid area (CSS Grid Level 1 SS10.1) --
    // that would move this bar horizontally (and, depending on
    // justify-self/stretch, vertically) without necessarily changing
    // nonLastRoot's height, so the height assertion alone cannot catch it.
    const floatingRect = floatingBar.getBoundingClientRect();
    const floatingTopOffset = floatingRect.top - nonLastRoot.getBoundingClientRect().top;
    expect(floatingRect.left).toBe(inFlowRect.left);
    expect(floatingRect.right).toBe(inFlowRect.right);
    expect(floatingTopOffset).toBe(inFlowTopOffset);
  });
});
