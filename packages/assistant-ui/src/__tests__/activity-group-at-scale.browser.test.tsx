// Activity trace at scale, measured in a real browser: the lane loads
// `@brainstrike/ui/globals.css` and `overrides.css` only, so every geometry
// asserted here is owned by the stylesheet.
import '@testing-library/jest-dom/vitest';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { Harness } from './assistant-activity-timeline-fixtures';
import { mustFind } from './browser-dom';

function read(id: string, path: string, failed = false) {
  return {
    args: { path },
    argsText: JSON.stringify({ path }),
    isError: failed,
    result: failed ? { error: `Path "${path}" does not exist.` } : { ok: true },
    toolCallId: id,
    toolName: 'brainstrike.readWorkspaceFile',
    type: 'tool-call' as const,
  };
}

const content = [
  ...Array.from({ length: 24 }, (_v, i) =>
    read(`call-${i}`, `packages/siphon/src/area/file-${i}.ts`)
  ),
  read('call-missing', 'packages/siphon/src/evidence/missing-fixture.ts', true),
  ...Array.from({ length: 12 }, (_v, i) => read(`call-b${i}`, `packages/ledger/src/file-${i}.ts`)),
];

it.each([480, 320])(
  'lays a long run out as one-line rows 2px apart with a one-line header at %i px',
  async (width) => {
    const { container } = render(
      <div className="assistant-ui-panel" style={{ width }}>
        <Harness
          adapter={{
            run() {
              throw new Error('A saved transcript must not call a model.');
            },
          }}
          initialMessages={[{ content, role: 'assistant' } as ThreadMessageLike]}
        />
      </div>
    );
    const group = await screen.findByTestId('assistant-activity-group');
    const header = mustFind(group, '.bs-activity-header').getBoundingClientRect();
    const summary = within(group).getByTestId('assistant-activity-summary').getBoundingClientRect();
    // The failed jump and the run strip share the status row without wrapping it.
    expect(header.height).toBeCloseTo(summary.height, 0);
    expect(within(group).getByRole('button', { name: 'Show 1 failed step' })).toBeVisible();
    // The strip yields to the headline: narrower mid-width, gone when narrow.
    const strip = within(group).getByTestId('assistant-activity-run-strip');
    if (width >= 480) {
      expect(strip.getBoundingClientRect().width).toBeGreaterThanOrEqual(40);
      expect(strip.getBoundingClientRect().right).toBeLessThanOrEqual(header.right + 0.5);
    } else {
      expect(strip).not.toBeVisible();
    }

    const user = userEvent.setup();
    await user.click(within(group).getByRole('button', { name: 'Expand activity' }));
    await user.click(within(group).getByRole('button', { name: 'Expand all' }));
    const members = [...group.querySelectorAll<HTMLElement>('.bs-cluster-member')];
    expect(members).toHaveLength(36);
    const rows = members.map((member) => mustFind(member, '.bs-step-row').getBoundingClientRect());
    expect(rows.every((row) => Math.round(row.height) === 28)).toBe(true);
    const [first, second] = members.map((member) => member.getBoundingClientRect());
    if (!(first && second)) {
      throw new Error('Expected open cluster members.');
    }
    expect(second.top - first.bottom).toBeCloseTo(2, 0);
    // The failure keeps its card between the two folded runs.
    const failed = within(group)
      .getAllByTestId('tool-fallback')
      .find((card) => card.getAttribute('data-chrome') === 'card');
    expect(failed).toHaveTextContent('missing-fixture.ts');
    // Nothing in the group widens the panel.
    const panel = mustFind(container, '.assistant-ui-panel') as HTMLElement;
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  }
);
