import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseTab } from '../database-tab';

vi.mock('../database-tab-chunk', () => ({
  DatabaseTab: () => <div>Database overview chunk</div>,
}));

describe('DatabaseTab', () => {
  it('renders the database content', () => {
    render(<DatabaseTab />);
    // Using getByText (sync) instead of findByText (async) because React.lazy()
    // was removed from DatabaseTab - the component now renders synchronously
    expect(screen.getByText('Database overview chunk')).toBeInTheDocument();
  });
});
