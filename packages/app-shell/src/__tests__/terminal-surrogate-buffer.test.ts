// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SurrogateBuffer } from '../terminal-panel/surrogate-buffer';

// 😀 U+1F600 = surrogate pair U+D83D U+DE00.
const EMOJI = '😀';
const HIGH = EMOJI.charCodeAt(0); // 0xD83D
const LOW = EMOJI.charCodeAt(1); // 0xDE00

describe('SurrogateBuffer', () => {
  it('passes a complete chunk through unchanged', () => {
    const buffer = new SurrogateBuffer();
    expect(buffer.push('hello world')).toBe('hello world');
    expect(buffer.flush()).toBe('');
  });

  it('passes a complete emoji through unchanged when not split', () => {
    const buffer = new SurrogateBuffer();
    expect(buffer.push(`a${EMOJI}b`)).toBe(`a${EMOJI}b`);
  });

  it('reassembles an emoji whose surrogate pair is split across two chunks', () => {
    const buffer = new SurrogateBuffer();
    // First event ends with the lone HIGH surrogate (the split the pty transport
    // can introduce at MAX_EVENT_CHUNK_CHARS).
    const first = `prefix${String.fromCharCode(HIGH)}`;
    const second = `${String.fromCharCode(LOW)}suffix`;

    const out1 = buffer.push(first);
    // The trailing lone high surrogate is deferred — never written as U+FFFD.
    expect(out1).toBe('prefix');
    expect(out1).not.toContain('�');

    const out2 = buffer.push(second);
    // The next chunk reunites the pair → the single correct emoji.
    expect(out2).toBe(`${EMOJI}suffix`);

    // Reassembled total equals the original text, no replacement chars.
    expect(out1 + out2).toBe(`prefix${EMOJI}suffix`);
    expect(out1 + out2).not.toContain('�');
  });

  it('handles a chunk that is exactly a lone high surrogate', () => {
    const buffer = new SurrogateBuffer();
    expect(buffer.push(String.fromCharCode(HIGH))).toBe('');
    expect(buffer.push(String.fromCharCode(LOW))).toBe(EMOJI);
  });

  it('handles consecutive split emojis across three chunks', () => {
    const buffer = new SurrogateBuffer();
    // ...H | L...H | L...
    const a = buffer.push(`x${String.fromCharCode(HIGH)}`);
    const b = buffer.push(`${String.fromCharCode(LOW)}y${String.fromCharCode(HIGH)}`);
    const c = buffer.push(`${String.fromCharCode(LOW)}z`);
    expect(a + b + c).toBe(`x${EMOJI}y${EMOJI}z`);
    expect(a + b + c).not.toContain('�');
  });

  it('flush emits a trailing lone high surrogate rather than dropping it', () => {
    const buffer = new SurrogateBuffer();
    expect(buffer.push(String.fromCharCode(HIGH))).toBe('');
    expect(buffer.flush()).toBe(String.fromCharCode(HIGH));
    // Idempotent.
    expect(buffer.flush()).toBe('');
  });

  it('does not defer a low surrogate (only the high-at-end split is handled)', () => {
    const buffer = new SurrogateBuffer();
    // A lone low surrogate at the end is passed through (not a transport split we
    // can repair) — no silent rewriting.
    const lowOnly = String.fromCharCode(LOW);
    expect(buffer.push(`a${lowOnly}`)).toBe(`a${lowOnly}`);
    expect(buffer.flush()).toBe('');
  });
});
