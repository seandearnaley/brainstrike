import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseTab } from '../database-tab';

vi.mock('../database-tab-chunk', () => ({
  DatabaseTab: () => <div>Database overview chunk</div>,
}));

describe('DatabaseTab', () => {
  it('renders the loading fallback before the chunk resolves and then shows content', async () => {
    render(<DatabaseTab />);
    expect(screen.getByTestId('database-tab-loading')).toBeInTheDocument();
    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
  });
});
