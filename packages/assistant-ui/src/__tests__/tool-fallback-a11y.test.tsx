import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement } from 'react';
import { beforeAll, describe, expect, test } from 'vitest';
import { ToolFallback } from '../tool-fallback';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

// intentionally minimal mock — see BST-469
const mockBaseProps = {
  addResult: () => {},
  args: { foo: 'bar' },
  argsText: '{"foo": "bar"}',
  resume: () => {},
  status: { type: 'complete' },
  toolCallId: 'test-call-id',
  toolName: 'test-tool',
  type: 'tool-call',
} as unknown as ComponentProps<typeof ToolFallback>;

function wrap(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('ToolFallback Accessibility', () => {
  test('expand/collapse button has correct aria-expanded state', async () => {
    const user = userEvent.setup();
    wrap(<ToolFallback {...mockBaseProps} />);

    const button = screen.getByRole('button', { name: /Expand details/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // BST-1681: the row IS the toggle, so its `title` is the raw tool id
    // (hover inspection); the expand/collapse wording lives in the
    // accessible name asserted above.
    expect(button).toHaveAttribute('title', 'test-tool');

    await user.click(button);

    const expandedButton = screen.getByRole('button', { name: /Collapse details/i });
    expect(expandedButton).toHaveAttribute('aria-expanded', 'true');
    expect(expandedButton).toHaveAttribute('title', 'test-tool');
  });

  test('aria-controls appears only while the pane it names is mounted, and keeps the same id across toggles', async () => {
    const user = userEvent.setup();
    const { container } = wrap(<ToolFallback {...mockBaseProps} result="test-result" />);

    // `ToolFallback` unmounts its details pane while collapsed, so an
    // `aria-controls` here would be a dangling IDREF — AT resolves it to
    // nothing. The package convention (`assistant-run-timeline.tsx`,
    // `assistant-tool-approval-notice.tsx`) is to emit the attribute only
    // when the target exists; `aria-expanded="false"` is what announces the
    // collapsed state. Rows whose body stays mounted (the reasoning row)
    // opt back in with `controlsAlwaysMounted`.
    const button = screen.getByRole('button', { name: /Expand details/i });
    expect(button).not.toHaveAttribute('aria-controls');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);

    const expandedButton = screen.getByRole('button', { name: /Collapse details/i });
    const controlsId = expandedButton.getAttribute('aria-controls');
    if (controlsId === null || controlsId.length === 0) {
      throw new Error('the expanded row must name the pane it toggles');
    }
    expect(expandedButton).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector(`#${CSS.escape(controlsId)}`)).toBeInTheDocument();

    await user.click(expandedButton);
    const collapsedButton = screen.getByRole('button', { name: /Expand details/i });
    expect(collapsedButton).not.toHaveAttribute('aria-controls');
    expect(collapsedButton).toHaveAttribute('aria-expanded', 'false');
    // BST-1685: an absent attribute alone would also be true if the row just
    // stopped NAMING an existing pane, which is not what "no dangling
    // aria-controls" claims. Prove the pane `controlsId` referred to is
    // genuinely gone from the DOM, not merely unreferenced. Queried against
    // `document`, not `container` (BST-1685 review round 2, Claude Minor 4):
    // `container.querySelector` only searches the render container, so a
    // portaled pane sitting outside it would leave a live element while this
    // assertion passed vacuously — exactly the failure mode the comment
    // above guards against.
    expect(document.getElementById(controlsId)).not.toBeInTheDocument();

    // The id is stable, not regenerated per expansion: a re-expanded row
    // names the same pane it named the first time.
    await user.click(collapsedButton);
    expect(screen.getByRole('button', { name: /Collapse details/i })).toHaveAttribute(
      'aria-controls',
      controlsId
    );
  });

  test('multiple instances have unique aria-controls IDs', async () => {
    const user = userEvent.setup();
    const { container } = wrap(
      <>
        <ToolFallback {...mockBaseProps} result="result-a" toolCallId="call-a" toolName="tool-a" />
        <ToolFallback {...mockBaseProps} result="result-b" toolCallId="call-b" toolName="tool-b" />
      </>
    );

    const collapsed = screen.getAllByRole('button', { name: /Expand details/i });
    expect(collapsed).toHaveLength(2);
    // Both panes have to be OPEN for there to be ids to compare: the
    // attribute is emitted only while the pane it names is mounted.
    for (const button of collapsed) {
      await user.click(button);
    }

    const buttons = screen.getAllByRole('button', { name: /Collapse details/i });
    expect(buttons).toHaveLength(2);
    const [first, second] = buttons;
    expect(first?.getAttribute('aria-controls')).toBeTruthy();
    expect(first?.getAttribute('aria-controls')).not.toBe(second?.getAttribute('aria-controls'));
    expect(container.querySelector('[id^="radix-"]')).not.toBeInTheDocument();
  });
});
