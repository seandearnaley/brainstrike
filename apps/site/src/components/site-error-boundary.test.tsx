import type { ErrorInfo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteErrorBoundary } from './site-error-boundary';

afterEach(() => vi.restoreAllMocks());

describe('SiteErrorBoundary diagnostics', () => {
  it('records the error and component stack when rendering halts', () => {
    const error = new Error('synthetic render failure');
    const info: ErrorInfo = { componentStack: '\n    at SyntheticComponent' };
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boundary = new SiteErrorBoundary({ children: null });

    boundary.componentDidCatch(error, info);

    expect(diagnostic).toHaveBeenCalledWith('Brainstrike site render failure', {
      componentStack: info.componentStack,
      error,
    });
  });
});
