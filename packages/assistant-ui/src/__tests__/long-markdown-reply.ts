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
  '## Summary',
  `${paragraph(11, 3)} See the [run log contract](https://example.com/docs/run-log) and the [streaming guide](https://example.com/docs/streaming) for details. ${paragraph(12, 3)}`
);

export const LONG_REPLY = sections.join('\n\n');

/** The longest markdown block (section) in the reply, in characters. */
export const LONG_REPLY_LONGEST_BLOCK = Math.max(...sections.map((section) => section.length));

/** Model-like tokens: an optional leading space and up to five characters. */
export const LONG_REPLY_TOKENS: readonly string[] = LONG_REPLY.match(/\s*\S{1,5}|\s+/g) ?? [];

export const LONG_REPLY_WORDS = LONG_REPLY.split(/\s+/).filter(Boolean).length;
