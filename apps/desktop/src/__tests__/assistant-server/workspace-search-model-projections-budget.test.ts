import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  resolveScaledToolResultBudget,
} from '@brainstrike/agent';
import {
  decodedWorkspaceTextModelOutputChars as decodedChars,
  projectGrepSearchModelOutput,
} from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it } from 'vitest';

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

describe('resolved per-run grep projection budgets', () => {
  it('fits smaller, byte-identical anchor, and larger pages across tiers', () => {
    const matches = Array.from({ length: 500 }, (_, index) => ({
      after: [],
      before: [],
      line: index + 1,
      lineText: `match-${index}-${'x'.repeat(80)}`,
      path: '/src/tiered.ts',
      rootId: 'root-a',
      rootName: 'alpha',
      source: 'both' as const,
    }));
    const raw = {
      candidatesTruncated: false,
      liveEngine: 'ripgrep',
      matches,
      offset: 0,
      outputMode: 'content',
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      totalMatches: matches.length,
      truncated: false,
    };
    const floorBudget = resolveScaledToolResultBudget(8192);
    const anchorBudget = resolveScaledToolResultBudget(131_072);
    const ceilingBudget = resolveScaledToolResultBudget(262_144);

    const floor = projectGrepSearchModelOutput(raw, floorBudget.domainModelResultCharBudget);
    const anchor = projectGrepSearchModelOutput(raw, anchorBudget.domainModelResultCharBudget);
    const defaultAnchor = projectGrepSearchModelOutput(raw);
    const ceiling = projectGrepSearchModelOutput(raw, ceilingBudget.domainModelResultCharBudget);

    expect(anchor).toEqual(defaultAnchor);
    expect(floor.value.length).toBeLessThan(anchor.value.length);
    expect(ceiling.value.length).toBeGreaterThan(anchor.value.length);
  });

  it('replays a stored projection above the resolved floor budget but below the ceiling', () => {
    const floorBudget = resolveScaledToolResultBudget(8192).domainModelResultCharBudget;
    const storedModelOutput = {
      type: 'text' as const,
      value: `grep files ${'x'.repeat(8000)}`,
    };

    expect(decodedChars([storedModelOutput.value])).toBeGreaterThan(floorBudget);
    expect(decodedChars([storedModelOutput.value])).toBeLessThanOrEqual(
      CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget
    );
    expect(projectGrepSearchModelOutput(storedModelOutput, floorBudget)).toEqual(storedModelOutput);
  });

  it('rejects a stored projection above the fixed replay ceiling', () => {
    const floorBudget = resolveScaledToolResultBudget(8192).domainModelResultCharBudget;
    const storedModelOutput = {
      type: 'text' as const,
      value: `grep content ${'x'.repeat(
        CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget
      )}`,
    };

    expect(() => projectGrepSearchModelOutput(storedModelOutput, floorBudget)).toThrow(
      `stored model projection exceeds the ${CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget}-character domain budget`
    );
  });
});
