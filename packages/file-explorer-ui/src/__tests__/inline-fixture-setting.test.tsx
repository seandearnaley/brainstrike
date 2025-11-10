import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import InlineFixtureSetting from '../inline-fixture-setting';

describe('InlineFixtureSetting', () => {
  it('renders the setting label and description', () => {
    render(<InlineFixtureSetting checked={false} disabled={false} onChange={vi.fn()} />);

    expect(screen.getByText('Enable Inline Fixture')).toBeInTheDocument();
    expect(
      screen.getByText(/Loads a scripted mock project so you can test without accessing/)
    ).toBeInTheDocument();
  });

  it('calls onChange when toggled', async () => {
    const onChange = vi.fn();
    render(<InlineFixtureSetting checked={false} disabled={false} onChange={onChange} />);

    const toggle = screen.getByRole('switch');
    await userEvent.click(toggle);

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('respects checked state', () => {
    render(<InlineFixtureSetting checked={true} disabled={false} onChange={vi.fn()} />);

    const toggle = screen.getByRole('switch');
    expect(toggle).toBeChecked();
  });

  it('respects disabled state', () => {
    render(<InlineFixtureSetting checked={false} disabled={true} onChange={vi.fn()} />);

    const toggle = screen.getByRole('switch');
    expect(toggle).toBeDisabled();
  });
});
