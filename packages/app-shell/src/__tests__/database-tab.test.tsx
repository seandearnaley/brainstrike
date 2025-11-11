import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseTab } from '../database-tab';

vi.mock('../database-tab-chunk', () => ({
  DatabaseTab: () => <div>Database overview chunk</div>,
}));

describe('DatabaseTab', () => {
  it('renders the lazy chunk', async () => {
    render(<DatabaseTab />);
    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
  });
});
