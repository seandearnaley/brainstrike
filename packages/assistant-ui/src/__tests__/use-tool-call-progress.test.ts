import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useIncrementalUtf8ByteLength } from '../use-tool-call-progress';

describe('useIncrementalUtf8ByteLength', () => {
  it('counts appended argument text without re-encoding what was already counted', () => {
    const { rerender, result } = renderHook(({ text }) => useIncrementalUtf8ByteLength(text), {
      initialProps: { text: '' },
    });
    expect(result.current).toBe(0);
    rerender({ text: '{"path":"a.ts","content":"' });
    expect(result.current).toBe(26);
    rerender({ text: '{"path":"a.ts","content":"é😀' });
    // 26 + 2 (é) + 4 (😀): the suffix is encoded, not the UTF-16 length.
    expect(result.current).toBe(32);
    rerender({ text: '{"path":"a.ts","content":"é😀' });
    expect(result.current).toBe(32);
  });

  it('recounts from scratch when the text is not an extension of the previous one', () => {
    const { rerender, result } = renderHook(({ text }) => useIncrementalUtf8ByteLength(text), {
      initialProps: { text: 'abcdef' },
    });
    expect(result.current).toBe(6);
    rerender({ text: 'xyz' });
    expect(result.current).toBe(3);
    rerender({ text: 'xyzé' });
    expect(result.current).toBe(5);
  });
});
