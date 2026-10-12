/**
 * BST-1929: a deterministic ~1,500-word (11.4k-character) markdown reply with
 * headings, lists, a table, three fenced code blocks and links. The browser
 * suites stream it through the recorded run's own text-delta chunk, one
 * model-sized token at a time, to pin how render work scales with reply length.
 */

const SENTENCES = [
  'The committed log is the single source of truth, and every view is a fold of its rows.',
  'Each streamed token reaches the renderer as uncommitted telemetry before the step commits.',
  'A projection that rebuilds only the affected message keeps unrelated rows referentially stable.',
  'When the host restarts, recovery reads the same rows and finishes any run it cannot continue.',
  'Selectors compare the folded objects by identity, so a token never re-renders an approval card.',
  'The composer stays responsive because markdown parsing runs at a deferred priority.',
  'A reconnect replays the gap from the last applied sequence number and nothing more.',
  'Long replies stress the parser, since every revealed frame re-parses the visible prefix.',
  'Child runs live in their own stores, so their progress never touches the root message.',
  'We measure the cost per token in production React, inside real Chromium, with the shipped build.',
];

function paragraph(seed: number, sentences: number): string {
  const out: string[] = [];
  for (let index = 0; index < sentences; index += 1) {
    out.push(SENTENCES[(seed * 7 + index * 3) % SENTENCES.length] ?? '');
  }
  return out.join(' ');
}

const TS_BLOCK = [
  '```ts',
  'export function foldRows(rows: readonly HostLogRow[]): FoldedView {',
  '  const runs = new Map<string, FoldedRun>();',
  '  for (const { event } of rows) {',
  "    if (event.type === 'run.started') {",
  "      runs.set(event.runId, { runId: event.runId, status: 'running', text: '' });",
  '      continue;',
  '    }',
  "    const run = 'runId' in event ? runs.get(event.runId) : undefined;",
  '    if (run) {',
  '      runs.set(run.runId, foldRunEvent(run, event));',
  '    }',
  '  }',
  '  return { runs: [...runs.values()] };',
  '}',
  '```',
].join('\n');

const BASH_BLOCK = [
  '```bash',
  'pnpm --filter @brainstrike/assistant-ui test:browser',
  'pnpm --filter @brainstrike/agent-host test:integration',
  'node scripts/run-turbo-command.mjs -- run build --filter=@brainstrike/desktop',
  'pnpm test:e2e e2e/host-thread-send-lifecycle.desktop.test.ts',
  '```',
].join('\n');

const JSON_BLOCK = [
  '```json',
  '{',
  '  "event": {',
  '    "type": "run.finished",',
  '    "runId": "68c245b5-a90c-4f87-8dea-55857759b10b",',
  '    "outcome": "interrupted",',
  '    "detail": "Host is closing"',
  '  },',
  '  "seq": 9,',
  '  "threadId": "03390b63-0000-4000-8000-000000000000"',
  '}',
  '```',
].join('\n');

const sections: string[] = ['# Streaming a committed conversation', paragraph(1, 5)];
const TOPICS = [
  'The fold',
  'Telemetry and the open step',
  'Recovery after a restart',
  'Selectors and identity',
  'Child runs',
  'Measuring the cost',
];
TOPICS.forEach((topic, index) => {
  sections.push(`## ${topic}`, paragraph(index + 2, 6));
  if (index % 2 === 0) {
    sections.push(
      [1, 2, 3, 4].map((item) => `- **Point ${item}:** ${paragraph(index + item, 1)}`).join('\n')
    );
  } else {
    sections.push([1, 2, 3].map((item) => `${item}. ${paragraph(index * 2 + item, 2)}`).join('\n'));
  }
  sections.push(`### Details for ${topic.toLowerCase()}`, paragraph(index + 5, 5));
  if (index === 1) {
    sections.push(TS_BLOCK);
  }
  if (index === 3) {
    sections.push(
      [
        '| Metric | Before | After |',
        '| --- | --- | --- |',
        '| Commits per token | 16 | 3 |',
        '| p95 per token | 5.0 ms | 1.4 ms |',
      ].join('\n')
    );
    sections.push(BASH_BLOCK);
  }
  if (index === 5) {
    sections.push(JSON_BLOCK);
  }
});
sections.push(
  '## Quotes and emphasis',
  [
    '> The committed log is the **single source of truth**, and *every* view is a fold of its rows.',
    '>',
    '> > A nested quote keeps its *emphasis* and its **weight**.',
    '>',
    '> - A list inside the quote, with **bold** and *italic* words.',
  ].join('\n'),
  `**Bold**, *italic* and ***both*** read as they did before. ${paragraph(13, 2)}`
);
sections.push(
  '## Summary',
  `${paragraph(11, 3)} See the [run log contract](https://example.com/docs/run-log) and the [streaming guide](https://example.com/docs/streaming) for details. ${paragraph(12, 3)}`
);
// Last on purpose: once a footnote appears, Streamdown parses the whole reply as
// one block (its block splitter keeps references and definitions together).
sections.push(
  '## Notes',
  'The fold has one reader.[^fold]',
  '[^fold]: Only the projection reads the committed rows.'
);

export const LONG_REPLY = sections.join('\n\n');

/** Model-like tokens: an optional leading space and up to five characters. */
export const LONG_REPLY_TOKENS: readonly string[] = LONG_REPLY.match(/\s*\S{1,5}|\s+/g) ?? [];

/**
 * The index of the token that carries the start of the reply's footnote. From
 * there on Streamdown parses the reply as one block, so incremental parsing is
 * measured before it.
 */
export const LONG_REPLY_FOOTNOTE_TOKEN = ((): number => {
  const footnote = LONG_REPLY.indexOf('[^');
  let offset = 0;
  for (const [index, token] of LONG_REPLY_TOKENS.entries()) {
    if (offset + token.length > footnote) {
      return index;
    }
    offset += token.length;
  }
  throw new Error('The long reply has no footnote.');
})();

export const LONG_REPLY_WORDS = LONG_REPLY.split(/\s+/).filter(Boolean).length;

/** A token that opens a new prose paragraph: a blank line, then a capital letter. */
const PARAGRAPH_START = /^\n\n[A-Z]/;

/** Tokens until the next blank line, i.e. how long the paragraph opened at `start` streams. */
function paragraphTokens(start: number): number {
  const next = LONG_REPLY_TOKENS.findIndex(
    (token, index) => index > start && token.includes('\n\n')
  );
  return (next === -1 ? LONG_REPLY_TOKENS.length : next) - start;
}

/**
 * Where to measure `windowTokens` streamed tokens at 10% and 50% of the reply and
 * at its end: the second token of a prose paragraph long enough for the whole
 * window, so every measured token extends the same open block and the windows
 * parse comparable text. `end` takes the last such paragraph that finishes
 * before the closing footnote (see LONG_REPLY_FOOTNOTE_TOKEN).
 */
export function longReplyWindowStarts(
  windowTokens: number
): Readonly<Record<'10%' | '50%' | 'end', number>> {
  const starts = LONG_REPLY_TOKENS.flatMap((token, index) =>
    PARAGRAPH_START.test(token) &&
    paragraphTokens(index) > windowTokens + 1 &&
    index + 1 + windowTokens <= LONG_REPLY_FOOTNOTE_TOKEN
      ? [index + 1]
      : []
  );
  const from = (fraction: number): number => {
    const start = starts.find((index) => index >= LONG_REPLY_TOKENS.length * fraction);
    if (start === undefined) {
      throw new Error(`No prose paragraph starts after ${fraction * 100}% of the reply.`);
    }
    return start;
  };
  const end = starts.at(-1);
  if (end === undefined) {
    throw new Error('The long reply has no prose paragraph long enough to measure.');
  }
  return { '10%': from(0.1), '50%': from(0.5), end };
}
