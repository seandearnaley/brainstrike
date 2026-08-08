import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { expect, it } from 'vitest';
import { projectGrepSearchModelOutput } from '../../assistant-server/workspace-search-model-projections';

it('fits nearly twice as many newline-dense grep rows with the decoded ruler', () => {
  const lineText = '\\'.repeat(50);
  const matches = Array.from({ length: 100 }, (_, index) => ({
    after: [],
    before: [],
    line: index + 1,
    lineText,
    path: '/src/newline-dense.ts',
    rootId: 'root-a',
    rootName: 'alpha',
    source: 'both' as const,
  }));

  const projected = projectGrepSearchModelOutput({
    candidatesTruncated: false,
    liveEngine: 'ripgrep',
    matches,
    offset: 0,
    outputMode: 'content',
    scanLimited: false,
    skippedMissingLineMetadata: 0,
    totalMatches: matches.length,
    truncated: false,
  });
  const decodedRulerRows = projected.value
    .split('\n')
    .filter((line) => /^ {2}\d+: /u.test(line)).length;

  let oldSerializedRulerRows = 0;
  for (let kept = 1; kept <= matches.length; kept += 1) {
    const candidateLines = [
      `grep content 1-${kept}/100`,
      '/src/newline-dense.ts',
      ...matches.slice(0, kept).map((match) => `  ${match.line}: ${match.lineText}`),
      ...(kept < matches.length
        ? [`continue: reuse the prior brainstrike.grepSearch input with offset=${kept}`]
        : []),
    ];
    const oldSerializedChars = JSON.stringify({
      type: 'text',
      value: candidateLines.join('\n'),
    }).length;
    if (oldSerializedChars <= MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
      oldSerializedRulerRows = kept;
    }
  }

  // BST-1195 recalibration: literal newlines and backslashes are decoded
  // model text, so the corrected ruler keeps 100 rows where the old JSON
  // envelope ruler stopped at 54 (1.85x as many rows).
  expect(oldSerializedRulerRows).toBe(54);
  expect(decodedRulerRows).toBe(100);
  expect(decodedRulerRows / oldSerializedRulerRows).toBeGreaterThan(1.8);
});
