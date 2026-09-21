import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApprovalRails } from '../approval-rails';

const edge = (id: string) => ({
  childRuntimeRunId: `child-run-${id}`,
  parentRuntimeRunId: `parent-run-${id}`,
  parentToolCallId: `call-${id}`,
  personaId: 'explore',
});

/**
 * Co-located pin for `ApprovalRails`' empty-path contract (BST-1765): the
 * `approval-row-card` call site no longer guards on the path, so correctness
 * depends entirely on this early return. The browser-lane structural guard in
 * `approval-row.browser.test.tsx` stays as the user-visible backstop.
 */
describe('ApprovalRails', () => {
  it('renders nothing for an empty path', () => {
    const { container } = render(<ApprovalRails path={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one rail per edge inside the rails wrapper', () => {
    const { container } = render(<ApprovalRails path={[edge('a'), edge('b')]} />);
    const wrapper = container.querySelector('.bs-approval-rails');
    expect(wrapper?.childElementCount).toBe(2);
    expect(
      [...(wrapper?.children ?? [])].every((child) => child.classList.contains('bs-approval-rail'))
    ).toBe(true);
  });
});
