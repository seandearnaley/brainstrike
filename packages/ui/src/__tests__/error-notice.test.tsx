import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorNotice } from '../error-notice';

describe('ErrorNotice', () => {
  it('announces the failure and runs Retry when pressed', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorNotice message="Artifacts could not be listed: offline" onRetry={onRetry} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Artifacts could not be listed: offline');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers nothing to press when the failure cannot be retried', () => {
    render(<ErrorNotice message="Cost could not be read" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Cost could not be read');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
