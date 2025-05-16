import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { useToastManager } from '../use-toast-manager';

describe('useToastManager', () => {
  it('should call toast with provided options', () => {
    const toast = vi.fn();
    const { result } = renderHook(() => useToastManager({ toast }));

    act(() => {
      result.current.showToast({
        title: 'Hello',
        description: 'World',
      });
    });

    expect(toast).toHaveBeenCalledWith({
      title: 'Hello',
      description: 'World',
      variant: 'default',
      action: undefined,
    });
  });

  it('should call toast with destructive variant for errors', () => {
    const toast = vi.fn();
    const { result } = renderHook(() => useToastManager({ toast }));
    const action = React.createElement('button', null, 'Retry');

    act(() => {
      result.current.showErrorToast('Error', 'Something went wrong', action);
    });

    expect(toast).toHaveBeenCalledWith({
      title: 'Error',
      description: 'Something went wrong',
      variant: 'destructive',
      action,
    });
  });

  it('should call toast with default variant for success', () => {
    const toast = vi.fn();
    const { result } = renderHook(() => useToastManager({ toast }));

    act(() => {
      result.current.showSuccessToast('Success', 'All good');
    });

    expect(toast).toHaveBeenCalledWith({
      title: 'Success',
      description: 'All good',
      variant: 'default',
      action: undefined,
    });
  });
});
