import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  type SavedBrowserOriginAnswers,
  type SavedBrowserOrigins,
  SavedBrowserOriginsSection,
} from '../settings/system/saved-browser-origins-section';

/** The host's saved answers, in memory. */
function savedOrigins(initial: SavedBrowserOriginAnswers): SavedBrowserOrigins & {
  readonly answers: Record<string, 'allow' | 'deny'>;
} {
  const answers: Record<string, 'allow' | 'deny'> = { ...initial };
  return {
    answers,
    read: vi.fn(async () => ({ ...answers })),
    remove: vi.fn(async (origin: string) => {
      delete answers[origin];
    }),
  };
}

/** BST-1178: Settings lists the sites the agent host saved an answer for, and removes one. */
describe('SavedBrowserOriginsSection', () => {
  it('lists each saved site with its answer, sorted, and removes one', async () => {
    const origins = savedOrigins({
      'http://localhost:5173': 'deny',
      'https://example.com': 'allow',
    });
    render(<SavedBrowserOriginsSection origins={origins} />);

    const list = await screen.findByRole('list', { name: 'Saved sites' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      expect.stringContaining('http://localhost:5173Not allowed'),
      expect.stringContaining('https://example.comAlways allowed'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove https://example.com' }));
    await waitFor(() => {
      expect(screen.queryByTestId('saved-browser-origin-https://example.com')).toBeNull();
    });
    expect(origins.remove).toHaveBeenCalledWith('https://example.com');
    expect(origins.answers).toEqual({ 'http://localhost:5173': 'deny' });
  });

  it('says when no site has a saved answer', async () => {
    render(<SavedBrowserOriginsSection origins={savedOrigins({})} />);
    expect(await screen.findByTestId('saved-browser-origins-empty')).not.toBeNull();
  });

  it('names a failed read and retries it', async () => {
    const origins = savedOrigins({ 'https://example.com': 'allow' });
    vi.mocked(origins.read).mockRejectedValueOnce(new Error('host unavailable'));
    render(<SavedBrowserOriginsSection origins={origins} />);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Unable to load saved sites: host unavailable'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('saved-browser-origin-https://example.com')).not.toBeNull();
  });

  it('names a failed removal and keeps the site listed', async () => {
    const origins = savedOrigins({ 'https://example.com': 'allow' });
    vi.mocked(origins.remove).mockRejectedValueOnce(new Error('store locked'));
    render(<SavedBrowserOriginsSection origins={origins} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove https://example.com' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't remove https://example.com: store locked"
    );
    expect(screen.getByTestId('saved-browser-origin-https://example.com')).not.toBeNull();
  });
});
