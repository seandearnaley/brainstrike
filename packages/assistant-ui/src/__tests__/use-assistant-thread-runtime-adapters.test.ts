import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAssistantThreadRuntimeAdapters } from '../use-assistant-thread-runtime-adapters';

describe('useAssistantThreadRuntimeAdapters', () => {
  it('registers no attachment adapter when the provider offers no attachments', () => {
    const { result } = renderHook(() => useAssistantThreadRuntimeAdapters(false));
    expect(result.current).toBeUndefined();
  });

  // An enabled→disabled vision switch keeps availability present. A new or
  // missing adapter there would drop images the user already staged.
  it('keeps one adapter instance while attachments stay available', () => {
    const { rerender, result } = renderHook(
      ({ present }) => useAssistantThreadRuntimeAdapters(present),
      { initialProps: { present: true } }
    );
    const first = result.current?.attachments;
    expect(first).toBeDefined();
    rerender({ present: true });
    expect(result.current?.attachments).toBe(first);
  });
});
