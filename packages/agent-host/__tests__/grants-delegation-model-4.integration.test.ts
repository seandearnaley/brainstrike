/** ADR-0010 and ADR-0031 as a model-based test, part 4 of 4 of the generated sequences. */
import { test } from 'vitest';
import { checkGeneratedSequences, GENERATED_PARTS } from './fixtures/grants-delegation-model.ts';

test(`every call is ran, asked or refused exactly as the policy, grants and admitted denies say (part 4 of ${GENERATED_PARTS})`, async () => {
  await checkGeneratedSequences();
}, 300_000);
