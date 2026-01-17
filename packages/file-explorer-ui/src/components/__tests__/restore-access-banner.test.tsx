import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RestoreAccessBanner } from '../restore-access-banner';

describe('RestoreAccessBanner', () => {
  it('renders pending banner with actions', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    const onChooseDifferent = vi.fn();
    const onDismiss = vi.fn();

    render(
      <RestoreAccessBanner
        folderName="project"
        onChooseDifferent={onChooseDifferent}
        onDismiss={onDismiss}
        onRestore={onRestore}
        variant="pending"
      />
    );

    expect(screen.getByText(/Restore access to your last folder/i)).toBeInTheDocument();
    expect(screen.getByText(/"project"/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /restore access/i }));
    expect(onRestore).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: /choose different folder/i }));
    expect(onChooseDifferent).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('renders stale banner without restore button', () => {
    render(
      <RestoreAccessBanner
        folderName="old"
        onChooseDifferent={vi.fn()}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        variant="stale"
      />
    );

    expect(screen.getByText(/Stored folder is no longer accessible/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restore access/i })).toBeNull();
  });
});
