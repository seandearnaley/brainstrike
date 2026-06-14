import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useProgressDescription, useProgressMessage } from '../../hooks/use-loading-progress';

describe('useProgressMessage', () => {
  it('should return cancelling message when isCancelling is true', () => {
    const { result } = renderHook(() => useProgressMessage(true, undefined, false, undefined));

    expect(result.current).toBe('Cancelling operation...');
  });

  it('should return custom message when provided', () => {
    const { result } = renderHook(() =>
      useProgressMessage(false, 'Custom loading message', false, undefined)
    );

    expect(result.current).toBe('Custom loading message');
  });

  it('should return folder-loading message for initial load without progress state', () => {
    const { result } = renderHook(() => useProgressMessage(false, undefined, true, undefined));

    expect(result.current).toBe('Loading folder...');
  });

  it('should return refreshing message when not initial load and no progress state', () => {
    const { result } = renderHook(() => useProgressMessage(false, undefined, false, undefined));

    expect(result.current).toBe('Refreshing file tree...');
  });

  it('should return scanning message during counting phase', () => {
    const progressState = { loaded: 0, total: 0, phase: 'counting' as const, currentPath: '' };
    const { result } = renderHook(() => useProgressMessage(false, undefined, false, progressState));

    expect(result.current).toBe('Scanning directory structure...');
  });

  it('should return preparing message when total is 0', () => {
    const progressState = { loaded: 0, total: 0, phase: 'loading' as const, currentPath: '' };
    const { result } = renderHook(() => useProgressMessage(false, undefined, false, progressState));

    expect(result.current).toBe('Preparing...');
  });

  it('should return progress message with percentage', () => {
    const progressState = { loaded: 50, total: 100, phase: 'loading' as const, currentPath: '' };
    const { result } = renderHook(() => useProgressMessage(false, undefined, false, progressState));

    expect(result.current).toBe('Processing files (50/100 - 50%)');
  });

  it('should include formatted path in progress message', () => {
    const progressState = {
      loaded: 25,
      total: 100,
      phase: 'loading' as const,
      currentPath: '/root/folder/subfolder/file.ts',
    };
    const { result } = renderHook(() => useProgressMessage(false, undefined, false, progressState));

    expect(result.current).toContain('Processing files (25/100 - 25%)');
    expect(result.current).toContain('.../subfolder/file.ts');
  });

  it('should show short path without truncation for paths with 2 or fewer parts', () => {
    const progressState = {
      loaded: 10,
      total: 100,
      phase: 'loading' as const,
      currentPath: 'folder/file.ts',
    };
    const { result } = renderHook(() => useProgressMessage(false, undefined, false, progressState));

    expect(result.current).toContain('folder/file.ts');
    expect(result.current).not.toContain('...');
  });

  it('should prioritize cancelling message over custom message', () => {
    const { result } = renderHook(() =>
      useProgressMessage(true, 'Custom message', false, undefined)
    );

    expect(result.current).toBe('Cancelling operation...');
  });
});

describe('useProgressDescription', () => {
  it('should return cancelling description when isCancelling is true', () => {
    const { result } = renderHook(() => useProgressDescription(true, undefined, undefined));

    expect(result.current).toBe('Please wait while the operation is safely cancelled...');
  });

  it('should return custom description when provided', () => {
    const { result } = renderHook(() =>
      useProgressDescription(false, 'Custom description', undefined)
    );

    expect(result.current).toBe('Custom description');
  });

  it('should return default wait message when no progress state', () => {
    const { result } = renderHook(() => useProgressDescription(false, undefined, undefined));

    expect(result.current).toBe('Please wait while we load the file tree');
  });

  it('should return counting phase message', () => {
    const progressState = { loaded: 0, total: 0, phase: 'counting' as const, currentPath: '' };
    const { result } = renderHook(() => useProgressDescription(false, undefined, progressState));

    expect(result.current).toBe('This may take a moment for large directories');
  });

  it('should return default wait message during loading phase', () => {
    const progressState = { loaded: 50, total: 100, phase: 'loading' as const, currentPath: '' };
    const { result } = renderHook(() => useProgressDescription(false, undefined, progressState));

    expect(result.current).toBe('Please wait while we load the file tree');
  });

  it('should prioritize cancelling description over custom description', () => {
    const { result } = renderHook(() =>
      useProgressDescription(true, 'Custom description', undefined)
    );

    expect(result.current).toBe('Please wait while the operation is safely cancelled...');
  });
});
