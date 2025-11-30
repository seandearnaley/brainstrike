import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Input } from '../../src/input';

describe('Input', () => {
  it('renders with given type and placeholder', () => {
    render(<Input placeholder="Email" type="email" />);
    const input = screen.getByPlaceholderText('Email');
    expect(input).toHaveAttribute('type', 'email');
  });

  it('applies custom className', () => {
    render(<Input className="custom" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveClass('custom');
  });
});
