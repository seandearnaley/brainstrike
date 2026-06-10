import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RestoreAccessBanner } from '../restore-access-banner';

describe('RestoreAccessBanner', () => {
  it('renders pending banner with actions (single folder)', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    const onChooseDifferent = vi.fn();
    const onDismiss = vi.fn();

    render(
      <RestoreAccessBanner
        folderNames={['project']}
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
        folderNames={['old']}
        onChooseDifferent={vi.fn()}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        variant="stale"
      />
    );

    expect(screen.getByText(/Stored folder is no longer accessible/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restore access/i })).toBeNull();
  });

  it('shows single folder name when folderNames has one entry', () => {
    render(
      <RestoreAccessBanner
        folderNames={['my-project']}
        onChooseDifferent={vi.fn()}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        variant="pending"
      />
    );

    expect(screen.getByText(/"my-project"/i)).toBeInTheDocument();
  });

  it('shows "N folders" copy when folderNames has multiple entries', () => {
    render(
      <RestoreAccessBanner
        folderNames={['project-a', 'project-b', 'project-c']}
        onChooseDifferent={vi.fn()}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        variant="pending"
      />
    );

    // Should mention number of folders (at least one element), not individual names
    const matches = screen.getAllByText(/3 folders/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // Should not show individual folder names
    expect(screen.queryByText(/"project-a"/i)).toBeNull();
  });

  it('shows "Restore access to N folders" title when n > 1', () => {
    render(
      <RestoreAccessBanner
        folderNames={['a', 'b']}
        onChooseDifferent={vi.fn()}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        variant="pending"
      />
    );

    expect(screen.getByText(/Restore access to 2 folders/i)).toBeInTheDocument();
  });
});
