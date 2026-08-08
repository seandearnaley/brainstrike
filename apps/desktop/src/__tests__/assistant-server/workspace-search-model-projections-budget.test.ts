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

  // Derive "how many rows would the OLD (JSON-serialized) ruler have kept"
  // from the REAL projector rather than hand-reconstructing its header/row/
  // continuation format: re-run projectGrepSearchModelOutput on each
  // candidate prefix (with `totalMatches` held at the true dataset size so
  // the continuation text stays realistic) and measure ITS actual output.
  // The current (decoded-ruler) projector never drops anything from a
  // prefix this small, so its rendering for `kept` items is exactly what
  // the old ruler would have judged for that same page — no duplicated
  // formatting knowledge, so a future format change can't silently drift
  // this baseline out of sync with reality.
  let oldSerializedRulerRows = 0;
  for (let kept = 1; kept <= matches.length; kept += 1) {
    const candidateProjected = projectGrepSearchModelOutput({
      candidatesTruncated: false,
      liveEngine: 'ripgrep',
      matches: matches.slice(0, kept),
      offset: 0,
      outputMode: 'content',
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      totalMatches: matches.length,
      truncated: false,
    });
    const oldSerializedChars = JSON.stringify(candidateProjected).length;
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
