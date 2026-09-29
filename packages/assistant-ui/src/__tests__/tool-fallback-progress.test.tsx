import { TooltipProvider } from '@brainstrike/ui';
import { act, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolFallback } from '../tool-fallback';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

// The RUNTIME shape, not the public type: assistant-stream's accumulator spreads
// the whole tool-call part into the renderer's props, including `state`
// ('partial-call' while argument text streams, 'call' once it finishes) and
// `timing.startedAt`. The fixture delivers exactly that shape — see
// `tool-call-args-state.contract.test.ts` for the pin against the installed
// accumulator.
const baseProps = {
  addResult: () => {},
  args: {},
  argsText: '',
  respondToApproval: () => {},
  resume: () => {},
  status: { type: 'running' as const },
  toolCallId: 'call-progress',
  toolName: 'brainstrike.writeFile',
  type: 'tool-call' as const,
};

function renderTool(props: Record<string, unknown>) {
  const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
  return render(
    <TooltipProvider>
      <Comp {...baseProps} {...props} />
    </TooltipProvider>
  );
}

const indicator = () => screen.getByTestId('assistant-thinking-indicator');

describe('ToolFallback streamed-input progress (BST-849)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows how much argument text has arrived while the model is still streaming it', () => {
    renderTool({ argsText: 'x'.repeat(3000), state: 'partial-call' });
    expect(indicator()).toHaveTextContent('Receiving input · 2.9 KB');
  });

  it('grows the counter as more argument text lands', () => {
    const view = renderTool({ argsText: 'x'.repeat(3000), state: 'partial-call' });
    const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
    view.rerender(
      <TooltipProvider>
        <Comp {...baseProps} argsText={'x'.repeat(22_528)} state="partial-call" />
      </TooltipProvider>
    );
    expect(indicator()).toHaveTextContent('Receiving input · 22.0 KB');
  });

  it('reads as running once the arguments are complete and the tool executes', () => {
    renderTool({ argsText: '{"path":"a.ts"}', state: 'call' });
    expect(indicator()).toHaveTextContent('Running');
    expect(indicator()).not.toHaveTextContent('Receiving input');
  });

  it('carries no live mark of its own — the row state glyph is the only one', () => {
    // BST-1681: the timing slot sits beside the step row's state glyph, which
    // already renders the live mark. A second `data-live` element here would
    // put two pulsing marks on one step (and break the hydration-liveness
    // count).
    renderTool({ argsText: '{"path":"a.ts"}', state: 'call' });
    expect(indicator().querySelectorAll('[data-live]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(1);
  });

  it('ticks an elapsed timer off the part timing while running', () => {
    const startedAt = Date.now() - 41_500;
    renderTool({ argsText: 'x'.repeat(40), state: 'partial-call', timing: { startedAt } });
    expect(indicator()).toHaveTextContent('Receiving input · 40 B · 41.5s');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(indicator()).toHaveTextContent('Receiving input · 40 B · 42.5s');
  });

  it('reads as running while a partial-call part has received no bytes yet', () => {
    renderTool({ argsText: '', state: 'partial-call' });
    expect(indicator()).toHaveTextContent('Running');
    expect(indicator()).not.toHaveTextContent('Receiving input');
  });

  it('shows no timer when the runtime recorded no timing', () => {
    renderTool({ argsText: 'x'.repeat(40), state: 'call' });
    expect(indicator()).toHaveTextContent('Running');
    expect(indicator().textContent).not.toMatch(/\d+\.\ds/);
  });

  it('renders no progress indicator once the call has completed', () => {
    renderTool({
      argsText: '{"path":"a.ts"}',
      result: { ok: true },
      state: 'result',
      status: { reason: 'stop', type: 'complete' },
      timing: { completedAt: Date.now(), startedAt: Date.now() - 1200 },
    });
    expect(screen.queryByTestId('assistant-thinking-indicator')).toBeNull();
  });
});
