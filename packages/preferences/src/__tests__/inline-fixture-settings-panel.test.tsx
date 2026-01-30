import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  InlineFixtureSettingsPanel,
  type InlineFixtureSettingsPanelProps,
} from '../settings/system/inline-fixture-settings-panel';

function renderPanel(props: Partial<InlineFixtureSettingsPanelProps> = {}) {
  const defaultProps: InlineFixtureSettingsPanelProps = {
    checked: false,
    isAvailable: true,
    isLoading: false,
    onChange: vi.fn(),
  };
  return render(<InlineFixtureSettingsPanel {...defaultProps} {...props} />);
}

describe('InlineFixtureSettingsPanel', () => {
  it('returns null when isAvailable is false', () => {
    const { container } = renderPanel({ isAvailable: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders when isAvailable is true', () => {
    renderPanel({ isAvailable: true });
    expect(screen.getByText('Developer: Inline Fixtures')).toBeInTheDocument();
  });

  it('renders label and description', () => {
    renderPanel();
    expect(screen.getByText('Developer: Inline Fixtures')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Load a built-in test fixture into the file explorer without selecting a real folder.'
      )
    ).toBeInTheDocument();
  });

  it('renders switch with correct aria-label', () => {
    renderPanel();
    const switchElement = screen.getByRole('switch', { name: 'Enable inline fixtures' });
    expect(switchElement).toBeInTheDocument();
  });

  it('shows checked state correctly when checked is true', () => {
    renderPanel({ checked: true });
    const switchElement = screen.getByRole('switch');
    expect(switchElement).toHaveAttribute('aria-checked', 'true');
  });

  it('shows unchecked state correctly when checked is false', () => {
    renderPanel({ checked: false });
    const switchElement = screen.getByRole('switch');
    expect(switchElement).toHaveAttribute('aria-checked', 'false');
  });

  it('disables switch when isLoading is true', () => {
    renderPanel({ isLoading: true });
    const switchElement = screen.getByRole('switch');
    expect(switchElement).toBeDisabled();
  });

  it('enables switch when isLoading is false', () => {
    renderPanel({ isLoading: false });
    const switchElement = screen.getByRole('switch');
    expect(switchElement).not.toBeDisabled();
  });

  it('calls onChange with true when toggled from unchecked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPanel({ checked: false, onChange });

    const switchElement = screen.getByRole('switch');
    await user.click(switchElement);

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('calls onChange with false when toggled from checked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPanel({ checked: true, onChange });

    const switchElement = screen.getByRole('switch');
    await user.click(switchElement);

    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('does not call onChange when switch is disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPanel({ isLoading: true, onChange });

    const switchElement = screen.getByRole('switch');
    await user.click(switchElement);

    expect(onChange).not.toHaveBeenCalled();
  });
});
