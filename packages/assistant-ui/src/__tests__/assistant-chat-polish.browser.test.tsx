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
import { ActivityTrace } from '../activity-trace';
import type { ActivitySummary } from '../activity-trace-model';
import { UserMessage } from '../assistant-ui-panel';
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

const activeSummary: ActivitySummary = {
  counts: { failed: 0, steps: 3 },
  live: 'Searching packages/db/src/registry.ts',
  resting: 'Searched',
  verbs: 'Searched',
  waiting: false,
};

const doneSummary: ActivitySummary = {
  counts: { failed: 0, steps: 5 },
  live: 'Working',
  resting: 'Read 2 files, searched',
  verbs: 'Read 2 files, searched',
  waiting: false,
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

describe('ActivityTrace (real browser)', () => {
  test('active turn: live current-step label + detail line in the header, body collapsed until expanded', async () => {
    const user = userEvent.setup();
    render(
      <div className="assistant-ui-panel">
        <ActivityTrace
          detail="packages/db/src/registry.ts"
          fallbackMs={undefined}
          incompleteReason={undefined}
          isActive
          restingOverride={null}
          summary={activeSummary}
        >
          <div data-testid="tool-rows">tool rows</div>
        </ActivityTrace>
      </div>
    );

    expect(screen.getByTestId('assistant-activity-working')).toHaveTextContent(
      'Searching packages/db/src/registry.ts'
    );
    expect(screen.getByText('packages/db/src/registry.ts')).toHaveClass('bs-trace-detail');
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
        <ActivityTrace
          detail={null}
          fallbackMs={12_000}
          incompleteReason={undefined}
          isActive={false}
          restingOverride={null}
          summary={doneSummary}
        >
          <div data-testid="tool-rows">tool rows</div>
        </ActivityTrace>
      </div>
    );

    // Asserted synchronously since BST-1681 task 6. This used to poll: the
    // headline carried `bs-trace-label` with `animation-fill-mode: both` on
    // its very first paint, so it began the frame at opacity 0 and real
    // Chromium read it as hidden until the 250ms crossfade landed. The
    // entrance is now gated to an actual change of wording
    // (`useLabelEnterClass`), and a first paint takes `bs-trace-label-static`
    // — `animation: none`, opaque immediately. Nothing else on this row
    // animates its opacity, so there is nothing left to wait for and a wait
    // here would only hide a regression behind a 2s timeout.
    expect(screen.getByText('Read 2 files, searched')).toBeVisible();
    expect(screen.getByText(/Worked for 12\.0s/)).toBeVisible();
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
        <ActivityTrace
          detail={null}
          fallbackMs={undefined}
          incompleteReason={undefined}
          isActive={false}
          restingOverride={null}
          summary={{ ...doneSummary, counts: { failed: 2, steps: 5 } }}
        />
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

  /**
   * BOTH messages carry this SAME string on purpose (BST-1687).
   *
   * The assertion below compares a rect taken in one message root against a
   * rect taken in the OTHER, which is only meaningful while the two roots
   * resolve the same columns. `grid-template-columns` is declared identically,
   * but its second track is `auto` -- sized by each root's OWN bubble content.
   * With two different strings the two roots resolved column 1 to 342.859px
   * and 328.438px, so the comparison was measuring two genuinely different
   * columns and only passed while an unrelated accident (see the settle step
   * in the test) kept both bubbles showing the same placeholder text.
   */
  const USER_MESSAGE_TEXT = 'A user message';

  /**
   * Keeps every message root clear of the browser's RESTING POINTER (BST-1687).
   *
   * Headless Chromium parks its pointer on the viewport origin even though this
   * suite never dispatches a real mouse event. Measured in the CI container
   * image (mcr.microsoft.com/playwright:v1.63.0-noble), not assumed: the live
   * hover chain there reads
   *
   *   HTML > BODY > DIV > .assistant-ui-panel > .bs-thread >
   *   .aui-thread-viewport > .aui-user-message-root
   *
   * and a 40x40 `:hover` probe grid over the 414x896 viewport lights exactly
   * one cell -- (0,0), i.e. x < 10.35px, y < 22.4px.
   *
   * MessagePrimitive.Root reads that state directly. Its ref callback attaches
   * the mouseenter/mouseleave listeners AND, whenever the element it is given
   * ALREADY matches `:hover`, queues `message.setIsHovering(true)`. A message
   * root laid out flush against the origin is therefore genuinely hovered
   * before this test touches it, and `autohide="not-last"` +
   * `autohideFloat="always"` mounts its bar FLOATING. That is correct component
   * behaviour and a broken test precondition: the subject here is a NON-hovered
   * non-last message, and the row-height and rect assertions below are only
   * about the hover the test itself performs.
   *
   * The offset only has to be greater than zero; the pointer assertions in the
   * test prove it did its job rather than trusting that it did. macOS headless
   * Chromium parks no pointer at all, which is why this was green on every
   * local run and red on the first CI run at 397c71a.
   */
  const POINTER_PARK_OFFSET_PX = 64;

  function TwoUserMessagesHarness() {
    const initialMessages: readonly ThreadMessageLike[] = [
      { content: [{ text: USER_MESSAGE_TEXT, type: 'text' }], role: 'user' },
      { content: [{ text: USER_MESSAGE_TEXT, type: 'text' }], role: 'user' },
    ];
    const runtime = useLocalRuntime(twoUserMessageModel, { initialMessages });

    return (
      <TooltipProvider>
        <AssistantRuntimeProvider runtime={runtime}>
          {/* Inline style, not a Tailwind utility: a class that the v4 content
              scan did not happen to pick up in this lane would silently leave
              the roots back under the pointer. */}
          <div style={{ paddingTop: `${POINTER_PARK_OFFSET_PX}px` }}>
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

    // ...and then settle the bubble TEXT before anything is measured
    // (BST-1687). UserMessageText resolves `./markdown-text` through a DYNAMIC
    // import and renders a "Loading message…" placeholder until it lands; that
    // placeholder is wider than the real text, and column 2 is `auto`, so the
    // swap widens column 1 -- and with it the bar's right edge -- by exactly
    // the text-width difference. The reference rect is read before the hover
    // and the floating rect after it, so a swap landing between the two turns
    // a pure measurement artifact into a rect mismatch. Whether it lands there
    // depends only on how warm the module graph already is, i.e. on which
    // other browser files ran first in the same Chromium page: cold, both
    // rects were read against the placeholder and agreed; warm, the floating
    // rect alone was read against the real text and came back a constant
    // 32.484375px wider.
    await waitFor(() => {
      const bubbles = screen.getAllByTestId('assistant-user-message-content');
      expect(bubbles).toHaveLength(2);
      for (const bubble of bubbles) {
        expect(bubble).toHaveTextContent(USER_MESSAGE_TEXT);
      }
    });

    const roots = document.querySelectorAll<HTMLElement>('.aui-user-message-root');
    expect(roots).toHaveLength(2);
    const [nonLastRoot, lastRoot] = roots;
    if (!(nonLastRoot && lastRoot)) {
      throw new Error('expected both user message roots');
    }

    // The three preconditions this test rests on, asserted rather than assumed
    // (all three were only assumed before BST-1687). They are deliberately
    // independent of the settle step and the harness offset that establish
    // them: removing either has to fail here, loudly, instead of re-arming a
    // flake that depends on the environment.
    for (const root of [nonLastRoot, lastRoot]) {
      // 1. Past the lazy-markdown placeholder, so no content-sized track can
      //    resize between the reference read and the floating read.
      expect(root).toHaveTextContent(USER_MESSAGE_TEXT);
      // 3. The REAL pointer rests clear of BOTH roots, so the only hover in
      //    this test is the one it performs itself. Established by the
      //    harness's POINTER_PARK_OFFSET_PX: drop that offset and the non-last
      //    root sits on the viewport origin, where headless Chromium parks its
      //    pointer, and this is true before a single event is dispatched.
      expect(root.matches(':hover')).toBe(false);
    }
    // 2. Both roots resolve the SAME columns -- not merely the same declared
    //    template -- so "the same spot" is a statement about one column.
    expect(getComputedStyle(nonLastRoot).gridTemplateColumns).toBe(
      getComputedStyle(lastRoot).gridTemplateColumns
    );

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

    // Both message roots share identical column geometry (asserted above:
    // same RESOLVED columns, same-width thread), so the floating bar's rect
    // must match the in-flow reference bar's rect -- same visual spot, it just no
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
