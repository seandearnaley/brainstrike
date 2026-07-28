import { describe, expect, it } from 'vitest';
import { stripProviderCitationMarkers } from '../citation-markers';

// Escaped rather than literal: these codepoints render as invisible glyphs (or
// tofu) in editors and diffs, so literals would make these fixtures unreviewable.
// Declared here instead of imported from the module under test so the tests pin
// the real wire codepoints, not whatever the implementation happens to define.
const START = '\u{E200}';
const TYPE_SEP = '\u{E202}';
const END = '\u{E201}';
const HIDDEN_START = '\u{E203}';
const HIDDEN_END = '\u{E204}';

describe('stripProviderCitationMarkers', () => {
  it('removes the cite marker OpenAI web search leaks into visible answer text', () => {
    // Verbatim shape observed live (GPT-5.6 Terra + native webSearch).
    const answer = `Latest stable Electron: v43.2.0, released July 21, 2026. ${START}cite${TYPE_SEP}turn0search0${END}`;

    expect(stripProviderCitationMarkers(answer)).toBe(
      'Latest stable Electron: v43.2.0, released July 21, 2026. '
    );
  });

  it('removes every marker in a multi-sentence answer regardless of reference type', () => {
    const answer = [
      `First claim.${START}cite${TYPE_SEP}turn0search0${END}`,
      `Second claim.${START}cite${TYPE_SEP}turn0news26${END}`,
      `A picture.${START}image${TYPE_SEP}turn0image2${END}`,
    ].join('\n');

    expect(stripProviderCitationMarkers(answer)).toBe('First claim.\nSecond claim.\nA picture.');
  });

  it('removes visually-hidden spans along with their payload', () => {
    const answer = `Visible.${HIDDEN_START}hidden bookkeeping${HIDDEN_END} Still visible.`;

    expect(stripProviderCitationMarkers(answer)).toBe('Visible. Still visible.');
  });

  it('suppresses an unterminated span so a half-streamed marker never flashes as prose', () => {
    // Mid-stream the closing delimiter has not arrived yet. Everything after an
    // unterminated START is, by construction, the marker's own payload.
    const partial = `Electron v43.2.0.${START}cite${TYPE_SEP}turn0sea`;

    expect(stripProviderCitationMarkers(partial)).toBe('Electron v43.2.0.');
  });

  it('drops orphan delimiters left by a message that starts mid-marker', () => {
    expect(stripProviderCitationMarkers(`turn0search0${END} rest of answer`)).toBe(
      'turn0search0 rest of answer'
    );
  });

  it('leaves ordinary prose, markdown, and real links untouched', () => {
    const answer = [
      '# Heading',
      '',
      'A [real link](https://example.com) and `code` and a $ sign.',
      '',
      '```ts\nconst x = 1;\n```',
    ].join('\n');

    expect(stripProviderCitationMarkers(answer)).toBe(answer);
  });

  it('returns the identical string when there is nothing to strip', () => {
    // Runs on every render of every message part; the marker-free path (the
    // overwhelming majority) must not allocate a copy.
    const answer = 'No markers here.';

    expect(Object.is(stripProviderCitationMarkers(answer), answer)).toBe(true);
  });

  it('handles the empty string', () => {
    expect(stripProviderCitationMarkers('')).toBe('');
  });
});
