import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { act, actUntil } from '../react-act';

describe('act', () => {
  it('ends an async scope when its test aborts, so the next render commits', async () => {
    const test = new AbortController();
    const outlived = actUntil(test.signal, () => new Promise<void>(() => undefined));
    test.abort(new Error('Test timed out'));
    await expect(outlived).rejects.toThrow('Test timed out');
    render(<p>committed</p>);
    expect(screen.getByText('committed')).toBeInTheDocument();
  });

  it('runs a scope opened after its test aborted to its end', async () => {
    const test = new AbortController();
    test.abort(new Error('Test timed out'));
    await expect(actUntil(test.signal, async () => 'cleaned up')).resolves.toBe('cleaned up');
  });

  it('flushes a render inside a scope that settles on its own', async () => {
    await act(async () => {
      render(<p>inside</p>);
      await Promise.resolve();
    });
    expect(screen.getByText('inside')).toBeInTheDocument();
  });
});
