import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { GitFailureDetails } from '../git-failure-details';

const REJECTED_PUSH = [
  'To github.com:example/repo.git',
  ' ! [rejected]        main -> main (fetch first)',
  "error: failed to push some refs to 'github.com:example/repo.git'",
  'hint: Updates were rejected because the remote contains work that you do not',
].join('\n');

describe('GitFailureDetails (BST-2136)', () => {
  it('shows a one-line failure as is, with no disclosure', () => {
    render(<GitFailureDetails error="fatal: not a valid object name" />);

    expect(screen.getByText('fatal: not a valid object name')).toBeInTheDocument();
    expect(screen.queryByTestId('git-failure-details')).not.toBeInTheDocument();
  });

  it('leads with the summary and keeps the full output one step away', async () => {
    const user = userEvent.setup();
    render(<GitFailureDetails error={REJECTED_PUSH} />);

    expect(
      screen.getByText('! [rejected] main -> main (fetch first)', { selector: 'p' })
    ).toBeInTheDocument();
    const details = screen.getByTestId('git-failure-details');
    expect(details).not.toHaveAttribute('open');

    // Native <summary> is in the tab order. jsdom does not run its Enter/Space
    // activation, so opening is clicked here; the keyboard toggle is verified
    // in the running app.
    await user.tab();
    expect(screen.getByText('Full git output')).toHaveFocus();
    await user.click(screen.getByText('Full git output'));
    expect(details).toHaveAttribute('open');
    expect(details.querySelector('pre')).toHaveTextContent('hint: Updates were rejected');
  });

  it('cuts very long output and says where the rest is', () => {
    render(<GitFailureDetails error={`fatal: boom\n${'x'.repeat(50_000)}`} />);

    const pre = screen.getByTestId('git-failure-details').querySelector('pre');
    expect(pre?.textContent?.length).toBeLessThan(20_200);
    expect(pre).toHaveTextContent(/more characters; the full output is in the log\.$/u);
  });
});
