/**
 * ADR-0010 and ADR-0031 as a model-based test, part 1 of 4 of the generated
 * sequences, with the pinned BST-2460 case. The model, the generators and the
 * driver are in ./fixtures/grants-delegation-model.ts.
 */
import { test } from 'vitest';
import {
  checkAgainstModel,
  checkGeneratedSequences,
  GENERATED_PARTS,
} from './fixtures/grants-delegation-model.ts';

test(`every call is ran, asked or refused exactly as the policy, grants and admitted denies say (part 1 of ${GENERATED_PARTS})`, async () => {
  await checkGeneratedSequences();
}, 300_000);

test.fails('a per-tool Allow removed while a child runs no longer lets the child skip asking (BST-2460)', async () => {
  await checkAgainstModel(
    {
      overrides: { read_file: 'allow' },
      policies: { edit: 'ask', execute: 'ask', read: 'ask' },
      yolo: false,
    },
    [
      {
        actor: 'worker',
        calls: [{ answer: { decision: 'deny' }, tool: 'read_file' }],
        kind: 'turn',
        midway: [{ kind: 'override', tool: 'read_file' }],
      },
    ],
    () => true
  );
});
